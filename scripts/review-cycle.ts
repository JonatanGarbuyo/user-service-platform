import {
  DEFAULT_MAX_CORRECTION_CYCLES,
  decideNextStep,
  formatReadySummary,
} from './review/cycle-policy.js';
import { qualityGatesPass, runQualityGates } from './review/gates.js';
import { parseReviewMarkers, selectCurrentHeadReports } from './review/result-marker.js';
import {
  getCurrentBranch,
  getCurrentHead,
  getPrForBranch,
  listPrComments,
  runAddressReview,
  runCommand,
  runReviewAxis,
} from './review/runner.js';
import { checkSafePush } from './review/safe-push.js';

interface CycleOptions {
  maxCycles: number;
  prArg?: string;
  push: boolean;
}

class HelpRequested extends Error {}

function parseArgs(argv: readonly string[]): CycleOptions {
  let maxCycles = DEFAULT_MAX_CORRECTION_CYCLES;
  let prArg: string | undefined;
  let push = true;

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
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: review-cycle [--max-cycles N] [--pr <number|url>] [--no-push|--push]');
      throw new HelpRequested();
    } else {
      throw new Error(`unknown argument: ${arg ?? '(missing)'}`);
    }
  }

  return { maxCycles, prArg, push };
}

// Repository-owned deterministic orchestration for the dual review loop
// (ticket #16). This command is not an LLM agent: it invokes the existing
// OpenCode review commands as workers, reads only machine-readable markers,
// keeps both axes independent, bounds corrections, and escalates decisions.
async function main(): Promise<void> {
  let options: CycleOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error('usage: review-cycle [--max-cycles N] [--pr <number|url>] [--no-push|--push]');
    process.exitCode = 1;
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
    return;
  }

  let head = await getCurrentHead();
  console.log(
    `Review cycle: PR #${String(pr.number)} (${pr.headRefName} -> ${pr.baseRefName}), HEAD ${head}`,
  );

  for (let cycles = 0; ; cycles += 1) {
    await Promise.all([
      runReviewAxis('review-standards', 'reviewer-standards', pr.number),
      runReviewAxis('review-spec', 'reviewer-spec', pr.number),
    ]);

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
        return;
      }
      console.log('');
      console.log(formatReadySummary({ head, cycles, gates: 'PASS' }));
      return;
    }

    if (decision.kind === 'awaiting-reviews') {
      console.error(
        `REVIEW-CYCLE INCOMPLETE: missing current-HEAD reports for: ${decision.missing.join(', ')}.`,
      );
      console.error('Rerun npm run review:cycle once both reviewers have published markers.');
      process.exitCode = 1;
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
      return;
    }

    if (decision.kind === 'cycle-limit-reached') {
      console.error(
        `REVIEW-CYCLE STOPPED: ${String(decision.cycles)} correction cycles reached the bound of ${String(decision.maxCycles)}. Escalating to a human.`,
      );
      process.exitCode = 1;
      return;
    }

    // decision.kind === 'address-review'
    console.log(
      `Blocking findings for ${head}: invoking /address-review (cycle ${String(cycles + 1)}).`,
    );
    await runAddressReview(pr.number);
    const newHead = await getCurrentHead();
    if (newHead === head) {
      console.error(
        'REVIEW-CYCLE STOPPED: /address-review left HEAD unchanged while blocking findings remain. Escalating to a human.',
      );
      process.exitCode = 1;
      return;
    }
    head = newHead;

    if (options.push) {
      const branch = await getCurrentBranch();
      const refreshedPr = await getPrForBranch(options.prArg);
      const { stdout } = await runCommand('git', ['status', '--porcelain']);
      const check = checkSafePush({
        currentBranch: branch,
        prHead: refreshedPr.headRefName,
        prBase: refreshedPr.baseRefName,
        pushTarget: 'origin',
        worktreeClean: stdout.trim() === '',
      });
      if (!check.ok) {
        console.error(`REVIEW-CYCLE PUSH REFUSED: ${check.reason}`);
        process.exitCode = 1;
        return;
      }
      await runCommand('git', ['push', 'origin', branch]);
      console.log(`Pushed correction commit via safe-push: origin/${branch} @ ${head}`);
    }
  }
}

await main();
