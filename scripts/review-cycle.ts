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
  type CommitCheckRun,
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
import {
  createRunSummaryRecorder,
  formatSummaryPathMessage,
  persistRunSummary,
  type CiDecision,
  type RunSummaryRecorder,
  type TerminalOutcome,
  type WorkerAttemptResult,
} from './review/run-summary.js';
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

function syncPrIntoRecorder(
  recorder: RunSummaryRecorder,
  pr: Awaited<ReturnType<typeof getPrForBranch>>,
): void {
  recorder.setPr({
    number: pr.number,
    ...(pr.url === undefined ? {} : { url: pr.url }),
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
  });
  recorder.setBranch(pr.headRefName, pr.baseRefName);
}

// Structured run summaries (ticket #22) are best-effort: a persistence
// failure is reported on stderr but never changes the terminal outcome or
// exit code of the review cycle itself.
async function concludeWithSummary(
  recorder: RunSummaryRecorder,
  outcome: TerminalOutcome,
  detail?: string,
): Promise<void> {
  const summary = recorder.finish(outcome, detail);
  try {
    const { latestPath } = await persistRunSummary(summary);
    console.log(formatSummaryPathMessage(latestPath));
  } catch (error) {
    console.error(
      `Run summary persistence failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function fatalDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

// Repository-owned deterministic orchestration for the dual review loop
// (ticket #16). This command is not an LLM agent: it invokes the existing
// OpenCode review commands as workers, reads only machine-readable markers,
// keeps both axes independent, bounds corrections, and escalates decisions.
// Headless agents do not depend on interactive questions: human-required
// decisions are surfaced as explicit NEEDS-DECISION/BLOCKED escalation output,
// never as hidden stdin prompts.
async function main(): Promise<void> {
  const recorder = createRunSummaryRecorder();
  try {
    await runCycle(recorder);
  } catch (error) {
    // Unhandled rejection/exception (e.g. a failed OpenCode worker): persist
    // a FATAL summary with the final known state, then rethrow so the
    // fatal-error boundary still reports REVIEW-CYCLE FATAL and rings once.
    // Persistence itself is best-effort inside concludeWithSummary.
    await concludeWithSummary(recorder, 'FATAL', fatalDetail(error));
    throw error;
  }
}

async function runCycle(recorder: RunSummaryRecorder): Promise<void> {
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
    await concludeWithSummary(recorder, 'BLOCKED', 'invalid arguments');
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
    await concludeWithSummary(recorder, 'BLOCKED', 'no pull request for the ticket branch');
    notifyTerminalBell(options.noBell);
    return;
  }
  syncPrIntoRecorder(recorder, pr);

  let head = await getCurrentHead();
  recorder.setInitialHead(head);
  recorder.setReviewedHead(head);
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
    await concludeWithSummary(recorder, 'BLOCKED', 'local HEAD diverged under --no-push');
    notifyTerminalBell(options.noBell);
    return;
  }
  if (startSync.kind === 'push-and-refresh') {
    console.log(`Local HEAD ${head} is ahead of the PR; pushing via safe-push.`);
    const pushed = await safePushBranch(options.prArg);
    if (!pushed.ok) {
      console.error(`REVIEW-CYCLE PUSH REFUSED: ${pushed.reason}`);
      process.exitCode = 1;
      await concludeWithSummary(recorder, 'BLOCKED', `push refused: ${pushed.reason}`);
      notifyTerminalBell(options.noBell);
      return;
    }
    const refreshed = await refreshPrUntilHead(options.prArg, head);
    if (refreshed === null) {
      console.error(
        'REVIEW-CYCLE ABORTED: the PR head did not catch up with the local HEAD after push.',
      );
      process.exitCode = 1;
      await concludeWithSummary(
        recorder,
        'BLOCKED',
        'PR head did not catch up with the local HEAD after push',
      );
      notifyTerminalBell(options.noBell);
      return;
    }
    pr = refreshed;
    syncPrIntoRecorder(recorder, pr);
  }

  for (
    let cycles = 0,
      markerRetries: MarkerRetries = { standards: 0, spec: 0 },
      pendingAxes: ('standards' | 'spec')[] | null = null;
    ;
  ) {
    recorder.setMarkerRetries({ ...markerRetries });
    const justRan: ('standards' | 'spec')[] =
      pendingAxes === null ? ['standards', 'spec'] : [...pendingAxes];
    const timings = new Map<'standards' | 'spec', { start: number; end: number }>();
    try {
      if (pendingAxes === null) {
        let standardsStart = 0;
        let standardsEnd = 0;
        let specStart = 0;
        let specEnd = 0;
        await Promise.all([
          (async (): Promise<void> => {
            standardsStart = Date.now();
            await runReviewAxis(
              'review-standards',
              pr.number,
              [],
              streamingWorkerExecutor('standards'),
            );
            standardsEnd = Date.now();
          })(),
          (async (): Promise<void> => {
            specStart = Date.now();
            await runReviewAxis('review-spec', pr.number, [], streamingWorkerExecutor('spec'));
            specEnd = Date.now();
          })(),
        ]);
        timings.set('standards', { start: standardsStart, end: standardsEnd });
        timings.set('spec', { start: specStart, end: specEnd });
      } else {
        // Blocker 1 (PR #17): a reviewer published without its marker — retry
        // only the missing axis instead of demanding manual intervention.
        for (const axis of pendingAxes) {
          const worker = reviewAxisWorker(axis);
          const startedAt = Date.now();
          await runReviewAxis(worker.command, pr.number, [], streamingWorkerExecutor(axis));
          timings.set(axis, { start: startedAt, end: Date.now() });
          markerRetries[axis] += 1;
        }
        pendingAxes = null;
      }
    } catch (workerError) {
      const failedAt = Date.now();
      for (const axis of justRan) {
        const timing = timings.get(axis);
        recorder.recordWorkerAttempt(
          axis,
          'ERROR',
          timing?.start ?? failedAt,
          timing?.end ?? failedAt,
        );
      }
      recorder.setMarkerRetries({ ...markerRetries });
      throw workerError;
    }

    const comments = await listPrComments(pr.number);
    const markerCount = comments.reduce((total, comment) => {
      return total + parseReviewMarkers(comment.body).length;
    }, 0);
    console.log(
      `Collected ${String(comments.length)} PR comments (${String(markerCount)} markers).`,
    );
    const reports = selectCurrentHeadReports(comments, head);
    for (const axis of justRan) {
      const report = axis === 'standards' ? reports.standards : reports.spec;
      const timing = timings.get(axis);
      const result: WorkerAttemptResult = report?.result ?? 'MISSING';
      recorder.recordWorkerAttempt(
        axis,
        result,
        timing?.start ?? Date.now(),
        timing?.end ?? Date.now(),
      );
    }
    recorder.setMarkerRetries({ ...markerRetries });
    recorder.setReviewedHead(head);

    const decision = decideNextStep({
      standards: reports.standards,
      spec: reports.spec,
      cycles,
      maxCycles: options.maxCycles,
    });

    if (decision.kind === 'ready-for-acceptance') {
      const gates = await runQualityGates();
      recorder.setQualityGates(gates.map((gate) => ({ name: gate.name, ok: gate.ok })));
      const pass = qualityGatesPass(gates);
      for (const gate of gates) {
        console.log(`gate ${gate.name}: ${gate.ok ? 'PASS' : 'FAIL'}`);
      }
      if (!pass) {
        console.error('REVIEW-CYCLE BLOCKED: quality gates failed for the reviewed HEAD.');
        process.exitCode = 1;
        await concludeWithSummary(recorder, 'BLOCKED', 'quality gates failed');
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
        await concludeWithSummary(recorder, 'BLOCKED', 'PR head moved away from the reviewed HEAD');
        notifyTerminalBell(options.noBell);
        return;
      }
      const repoSlug = await getRepoSlug();
      let checkDecision: CheckPollDecision = 'pending';
      let lastRuns: CommitCheckRun[] = [];
      for (let attempt = 0; attempt < CHECK_POLL_ATTEMPTS; attempt += 1) {
        const runs = await fetchCommitCheckRuns(repoSlug, head);
        lastRuns = runs;
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
      const ciDecision: CiDecision =
        checkDecision === 'pass' ? 'pass' : checkDecision === 'fail' ? 'fail' : 'pending';
      recorder.setCi(
        ciDecision,
        lastRuns.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion })),
      );
      if (checkDecision !== 'pass') {
        console.error(
          'REVIEW-CYCLE BLOCKED: CI checks for the exact reviewed HEAD are not all successful.',
        );
        process.exitCode = 1;
        await concludeWithSummary(
          recorder,
          'BLOCKED',
          'CI checks for the reviewed HEAD are not successful',
        );
        notifyTerminalBell(options.noBell);
        return;
      }
      console.log('');
      console.log(formatReadySummary({ head, cycles, gates: 'PASS' }));
      await concludeWithSummary(recorder, 'READY', 'ready for final acceptance');
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
      await concludeWithSummary(
        recorder,
        'BLOCKED',
        `missing current-HEAD reports for: ${decision.missing.join(', ')}`,
      );
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
      await concludeWithSummary(
        recorder,
        'NEEDS-DECISION',
        `${decision.axis} reported NEEDS-DECISION`,
      );
      notifyTerminalBell(options.noBell);
      return;
    }

    if (decision.kind === 'cycle-limit-reached') {
      console.error(
        `REVIEW-CYCLE STOPPED: ${String(decision.cycles)} correction cycles reached the bound of ${String(decision.maxCycles)}. Escalating to a human.`,
      );
      process.exitCode = 1;
      await concludeWithSummary(recorder, 'STOPPED', 'correction-cycle bound reached');
      notifyTerminalBell(options.noBell);
      return;
    }

    // decision.kind === 'address-review'
    cycles += 1;
    console.log(
      `Blocking findings for ${head}: invoking /address-review (correction cycle ${String(cycles)}).`,
    );
    const addressStartedAt = Date.now();
    try {
      await runAddressReview(pr.number, streamingWorkerExecutor('address-review'));
    } catch (addressError) {
      recorder.recordAddressReviewAttempt('error', addressStartedAt, Date.now());
      throw addressError;
    }
    const addressEndedAt = Date.now();
    const newHead = await getCurrentHead();
    if (newHead === head) {
      recorder.recordAddressReviewAttempt('unchanged', addressStartedAt, addressEndedAt);
      console.error(
        'REVIEW-CYCLE STOPPED: /address-review left HEAD unchanged while blocking findings remain. Escalating to a human.',
      );
      process.exitCode = 1;
      await concludeWithSummary(recorder, 'STOPPED', '/address-review left HEAD unchanged');
      notifyTerminalBell(options.noBell);
      return;
    }
    recorder.recordAddressReviewAttempt('advanced', addressStartedAt, addressEndedAt);
    head = newHead;
    recorder.setReviewedHead(head);
    markerRetries = { standards: 0, spec: 0 };

    if (options.push) {
      const pushed = await safePushBranch(options.prArg);
      if (!pushed.ok) {
        console.error(`REVIEW-CYCLE PUSH REFUSED: ${pushed.reason}`);
        process.exitCode = 1;
        await concludeWithSummary(recorder, 'BLOCKED', `push refused: ${pushed.reason}`);
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
