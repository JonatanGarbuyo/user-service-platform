import { notifyTerminalBell } from './review/bell.js';
import { parseNoBellFlag, runWithFatalBoundary } from './review/fatal.js';
import {
  DEFAULT_MAX_CORRECTION_CYCLES,
  DEFAULT_MAX_MARKER_RETRIES,
  axesEligibleForMarkerRetry,
  decideNextStep,
  decideStartSync,
  formatReadySummary,
  type MarkerRetries,
} from './review/cycle-policy.js';
import { qualityGatesPass, runQualityGates } from './review/gates.js';
import {
  CHECK_POLL_ATTEMPTS,
  CHECK_POLL_DELAY_MS,
  decideCheckPoll,
  fetchCommitCheckRuns,
  getRepoSlug,
  type CheckPollDecision,
} from './review/pr-checks.js';
import { parseReviewMarkers, selectCurrentHeadReports } from './review/result-marker.js';
import {
  getCurrentHead,
  getPrForBranch,
  listPrComments,
  reviewAxisWorker,
  runAddressReview,
  runReviewAxis,
  type CommandExecutor,
} from './review/runner.js';
import { safePushBranch } from './review/safe-push.js';
import { runWorkerStream } from './review/worker-stream.js';

interface CycleOptions {
  maxCycles: number;
  prArg?: string;
  push: boolean;
  noBell: boolean;
}

class HelpRequested extends Error {}

const PR_REFRESH_ATTEMPTS = 5;
const PR_REFRESH_DELAY_MS = 5000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function refreshPrUntilHead(
  prArg: string | undefined,
  localHead: string,
): Promise<Awaited<ReturnType<typeof getPrForBranch>> | null> {
  for (let attempt = 0; attempt < PR_REFRESH_ATTEMPTS; attempt += 1) {
    const pr = await getPrForBranch(prArg);
    if (pr.headRefOid.toLowerCase() === localHead.toLowerCase()) {
      return pr;
    }
    if (attempt < PR_REFRESH_ATTEMPTS - 1) {
      await sleep(PR_REFRESH_DELAY_MS);
    }
  }
  return null;
}

// OpenCode workers stream live prefixed output (PR #17 dogfood finding) so
// the single long-running command shows liveness. Short git/gh/npm commands
// stay on the buffered path. The injected `CommandExecutor` seam is unchanged,
// so tests still observe exact invocations without real subprocesses.
function streamingWorkerExecutor(label: string): CommandExecutor {
  return (command, args) => runWorkerStream(command, args, { label });
}

function parseArgs(argv: readonly string[]): CycleOptions {
  let maxCycles = DEFAULT_MAX_CORRECTION_CYCLES;
  let prArg: string | undefined;
  let push = true;
  let noBell = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max-cycles') {
      const raw = argv[index + 1];
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--max-cycles requires a non-negative integer, got ${raw ?? '(missing)'}`);
      }
      maxCycles = parsed;
      index += 1;
    } else if (arg === '--pr') {
      const raw = argv[index + 1];
      if (raw === undefined || raw === '') {
        throw new Error('--pr requires a PR number or URL');
      }
      prArg = raw;
      index += 1;
    } else if (arg === '--no-push') {
      push = false;
    } else if (arg === '--push') {
      push = true;
    } else if (arg === '--no-bell') {
      noBell = true;
    } else if (arg === '--bell') {
      noBell = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: review-cycle [--max-cycles N] [--pr <number|url>] [--no-push|--push] [--no-bell|--bell]',
      );
      throw new HelpRequested();
    } else {
      throw new Error(`unknown argument: ${arg ?? '(missing)'}`);
    }
  }

  return { maxCycles, prArg, push, noBell };
}

// Repository-owned deterministic orchestration for the dual review loop
// (ticket #16). This command is not an LLM agent: it invokes the existing
// OpenCode review commands as workers, reads only machine-readable markers,
// keeps both axes independent, bounds corrections, and escalates decisions.
// Headless agents do not depend on interactive questions: human-required
// decisions are surfaced as explicit NEEDS-DECISION/BLOCKED escalation output,
// never as hidden stdin prompts.
async function main(): Promise<void> {
  let options: CycleOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      'usage: review-cycle [--max-cycles N] [--pr <number|url>] [--no-push|--push] [--no-bell|--bell]',
    );
    process.exitCode = 1;
    notifyTerminalBell(parseNoBellFlag(process.argv.slice(2)));
    return;
  }

  let pr: Awaited<ReturnType<typeof getPrForBranch>>;
  try {
    pr = await getPrForBranch(options.prArg);
  } catch {
    console.error('REVIEW-CYCLE ABORTED: no pull request found for the current ticket branch.');
    console.error(
      'Push the ticket branch and open a draft PR before running npm run review:cycle.',
    );
    process.exitCode = 1;
    notifyTerminalBell(options.noBell);
    return;
  }

  let head = await getCurrentHead();
  console.log(
    `Review cycle: PR #${String(pr.number)} (${pr.headRefName} -> ${pr.baseRefName}), HEAD ${head}`,
  );

  // Blocker 2 (PR #17): markers are matched against the local HEAD, so refuse
  // to review while the PR still points at an older SHA.
  const startSync = decideStartSync({
    localHead: head,
    prHeadOid: pr.headRefOid,
    push: options.push,
  });
  if (startSync.kind === 'abort-diverged') {
    console.error(
      'REVIEW-CYCLE ABORTED: local HEAD differs from the PR head and --no-push was passed.',
    );
    console.error('Push the ticket branch first, then rerun npm run review:cycle.');
    process.exitCode = 1;
    notifyTerminalBell(options.noBell);
    return;
  }
  if (startSync.kind === 'push-and-refresh') {
    console.log(`Local HEAD ${head} is ahead of the PR; pushing via safe-push.`);
    const pushed = await safePushBranch(options.prArg);
    if (!pushed.ok) {
      console.error(`REVIEW-CYCLE PUSH REFUSED: ${pushed.reason}`);
      process.exitCode = 1;
      notifyTerminalBell(options.noBell);
      return;
    }
    const refreshed = await refreshPrUntilHead(options.prArg, head);
    if (refreshed === null) {
      console.error(
        'REVIEW-CYCLE ABORTED: the PR head did not catch up with the local HEAD after push.',
      );
      process.exitCode = 1;
      notifyTerminalBell(options.noBell);
      return;
    }
    pr = refreshed;
  }

  for (
    let cycles = 0,
      markerRetries: MarkerRetries = { standards: 0, spec: 0 },
      pendingAxes: ('standards' | 'spec')[] | null = null;
    ;
  ) {
    if (pendingAxes === null) {
      await Promise.all([
        runReviewAxis('review-standards', pr.number, [], streamingWorkerExecutor('standards')),
        runReviewAxis('review-spec', pr.number, [], streamingWorkerExecutor('spec')),
      ]);
    } else {
      // Blocker 1 (PR #17): a reviewer published without its marker — retry
      // only the missing axis instead of demanding manual intervention.
      for (const axis of pendingAxes) {
        const worker = reviewAxisWorker(axis);
        await runReviewAxis(worker.command, pr.number, [], streamingWorkerExecutor(axis));
        markerRetries[axis] += 1;
      }
      pendingAxes = null;
    }

    const comments = await listPrComments(pr.number);
    const markerCount = comments.reduce((total, comment) => {
      return total + parseReviewMarkers(comment.body).length;
    }, 0);
    console.log(
      `Collected ${String(comments.length)} PR comments (${String(markerCount)} markers).`,
    );
    const reports = selectCurrentHeadReports(comments, head);

    const decision = decideNextStep({
      standards: reports.standards,
      spec: reports.spec,
      cycles,
      maxCycles: options.maxCycles,
    });

    if (decision.kind === 'ready-for-acceptance') {
      const gates = await runQualityGates();
      const pass = qualityGatesPass(gates);
      for (const gate of gates) {
        console.log(`gate ${gate.name}: ${gate.ok ? 'PASS' : 'FAIL'}`);
      }
      if (!pass) {
        console.error('REVIEW-CYCLE BLOCKED: quality gates failed for the reviewed HEAD.');
        process.exitCode = 1;
        notifyTerminalBell(options.noBell);
        return;
      }
      // Blocker 2 (PR #17): confirm the PR still points at the reviewed HEAD
      // and CI checks for that exact commit are green before claiming READY.
      const finalPr = await getPrForBranch(options.prArg);
      if (finalPr.headRefOid.toLowerCase() !== head.toLowerCase()) {
        console.error(
          'REVIEW-CYCLE BLOCKED: the PR head moved away from the reviewed HEAD. Rerun npm run review:cycle.',
        );
        process.exitCode = 1;
        notifyTerminalBell(options.noBell);
        return;
      }
      const repoSlug = await getRepoSlug();
      let checkDecision: CheckPollDecision = 'pending';
      for (let attempt = 0; attempt < CHECK_POLL_ATTEMPTS; attempt += 1) {
        const runs = await fetchCommitCheckRuns(repoSlug, head);
        for (const run of runs) {
          console.log(`check ${run.name}: ${run.status}/${run.conclusion ?? 'none'}`);
        }
        checkDecision = decideCheckPoll(runs);
        if (checkDecision !== 'pending') {
          break;
        }
        if (attempt < CHECK_POLL_ATTEMPTS - 1) {
          console.log(`CI checks for ${head} are pending; waiting before rechecking.`);
          await sleep(CHECK_POLL_DELAY_MS);
        }
      }
      if (checkDecision !== 'pass') {
        console.error(
          'REVIEW-CYCLE BLOCKED: CI checks for the exact reviewed HEAD are not all successful.',
        );
        process.exitCode = 1;
        notifyTerminalBell(options.noBell);
        return;
      }
      console.log('');
      console.log(formatReadySummary({ head, cycles, gates: 'PASS' }));
      notifyTerminalBell(options.noBell);
      return;
    }

    if (decision.kind === 'awaiting-reviews') {
      const retryAxes = axesEligibleForMarkerRetry(
        decision.missing,
        markerRetries,
        DEFAULT_MAX_MARKER_RETRIES,
      );
      if (retryAxes.length > 0) {
        console.log(
          `Missing current-HEAD markers for: ${retryAxes.join(', ')}. Retrying only those reviewers (bounded to ${String(DEFAULT_MAX_MARKER_RETRIES)} attempts per axis).`,
        );
        pendingAxes = retryAxes;
        continue;
      }
      console.error(
        `REVIEW-CYCLE INCOMPLETE: missing current-HEAD reports for: ${decision.missing.join(', ')} after ${String(DEFAULT_MAX_MARKER_RETRIES)} retries.`,
      );
      console.error('Inspect the reviewer output on the PR; markers may be malformed.');
      process.exitCode = 1;
      notifyTerminalBell(options.noBell);
      return;
    }

    if (decision.kind === 'needs-decision') {
      console.error(
        `REVIEW-CYCLE ESCALATED: the ${decision.axis} axis reported NEEDS-DECISION for ${head}.`,
      );
      console.error(
        'Product, architecture, public-contract, infrastructure-provider, or security-policy decisions belong to planning — not to this loop. Stopping without code changes.',
      );
      process.exitCode = 2;
      notifyTerminalBell(options.noBell);
      return;
    }

    if (decision.kind === 'cycle-limit-reached') {
      console.error(
        `REVIEW-CYCLE STOPPED: ${String(decision.cycles)} correction cycles reached the bound of ${String(decision.maxCycles)}. Escalating to a human.`,
      );
      process.exitCode = 1;
      notifyTerminalBell(options.noBell);
      return;
    }

    // decision.kind === 'address-review'
    cycles += 1;
    console.log(
      `Blocking findings for ${head}: invoking /address-review (correction cycle ${String(cycles)}).`,
    );
    await runAddressReview(pr.number, streamingWorkerExecutor('address-review'));
    const newHead = await getCurrentHead();
    if (newHead === head) {
      console.error(
        'REVIEW-CYCLE STOPPED: /address-review left HEAD unchanged while blocking findings remain. Escalating to a human.',
      );
      process.exitCode = 1;
      notifyTerminalBell(options.noBell);
      return;
    }
    head = newHead;
    markerRetries = { standards: 0, spec: 0 };

    if (options.push) {
      const pushed = await safePushBranch(options.prArg);
      if (!pushed.ok) {
        console.error(`REVIEW-CYCLE PUSH REFUSED: ${pushed.reason}`);
        process.exitCode = 1;
        notifyTerminalBell(options.noBell);
        return;
      }
      console.log(`Pushed correction commit via safe-push: origin/${pushed.branch} @ ${head}`);
    }
  }
}

// Fatal-error boundary (final acceptance on PR #19): handled terminal paths
// above return normally with their own notification, so this catch fires only
// for unhandled rejections/exceptions such as a failed OpenCode worker. It
// reports REVIEW-CYCLE FATAL, sets a non-zero exit code, and rings the bell
// once per the TTY/CI/--no-bell policy — never twice for one terminal state.
await runWithFatalBoundary(main, process.argv.slice(2));
