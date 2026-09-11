import { qualityGatesPass, runQualityGates, type GateResult } from '../review/gates.js';
import {
  getCurrentBranch,
  getCurrentHead,
  getPrForBranch,
  isWorktreeClean,
  runCommand,
  type CommandExecutor,
} from '../review/runner.js';
import { checkSafePush, type SafePushCheck } from '../review/safe-push.js';
import { runWorkerStream } from '../review/worker-stream.js';

// Deterministic ticket orchestration for `npm run agent:ticket -- <issue>`
// (ticket #23). One repository-owned command drives a clean `main` worktree
// through branch creation -> `/implement` -> quality gates -> safe push ->
// draft PR -> the existing `review:cycle`, stopping at READY FOR FINAL
// ACCEPTANCE. This module never merges, deploys, publishes, mutates
// Cloudflare resources, or handles secrets: the only remote writes are a
// ticket-branch push and a draft PR creation. Existing behaviour is reused,
// not reimplemented: safe-push guards, the repository gate list, and the
// review:cycle command (including its #22 run evidence) stay authoritative.
export function parseTicketArg(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(
      `agent:ticket requires a positive integer issue number, got ${raw ?? '(missing)'}`,
    );
  }
  return Number.parseInt(trimmed, 10);
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug === '' ? 'ticket' : slug;
}

export function ticketBranchName(ticket: number, title: string): string {
  return `ticket/${String(ticket)}-${slugifyTitle(title)}`;
}

// `/implement` runs headlessly with `opencode run --auto --command implement`.
// No `--agent` flag is passed: the implement command frontmatter remains the
// single source of truth for the implementer model, mirroring the review
// workers in `scripts/review/runner.ts`.
export function buildImplementArgs(ticket: number): string[] {
  return ['run', '--auto', '--command', 'implement', String(ticket)];
}

// The existing `review:cycle` stays separately usable; the wrapper invokes it
// unchanged rather than duplicating its review/correction logic.
export function buildReviewCycleArgs(): string[] {
  return ['run', 'review:cycle'];
}

export function formatPrTitle(title: string, ticket: number): string {
  return `${title} (#${String(ticket)})`;
}

export function formatPrBody(ticket: number): string {
  return `Automated implementation of #${String(ticket)} via \`npm run agent:ticket\`.`;
}

export interface PrCreateOptions {
  branch: string;
  title: string;
  ticket: number;
}

export function buildPrCreateArgs(options: PrCreateOptions): string[] {
  return [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    options.branch,
    '--draft',
    '--title',
    formatPrTitle(options.title, options.ticket),
    '--body',
    formatPrBody(options.ticket),
  ];
}

export interface StartState {
  currentBranch: string;
  worktreeClean: boolean;
}

export type StartStateCheck = { ok: true } | { ok: false; reason: string };

// Unsafe or ambiguous starting states are refused, never repaired: the
// wrapper must start from a clean `main` worktree so it cannot absorb or
// mutate unrelated work.
export function checkStartState(state: StartState): StartStateCheck {
  if (state.currentBranch !== 'main') {
    return {
      ok: false,
      reason: `refusing to start from ${state.currentBranch}: run npm run agent:ticket from a clean main worktree`,
    };
  }
  if (!state.worktreeClean) {
    return {
      ok: false,
      reason: 'refusing to start with a dirty worktree: commit or stash first so it is clean',
    };
  }
  return { ok: true };
}

export interface MainCurrency {
  localHead: string;
  remoteHead: string;
}

export type MainCurrencyCheck = { ok: true } | { ok: false; reason: string };

// Ticket #23 requires starting from a *current* main, not just a clean one:
// a stale local main would silently base the ticket branch on outdated code.
// The remote is only inspected (`ls-remote`); local refs and the worktree are
// never mutated here, and nothing is rebased or merged automatically.
export function checkMainCurrency(currency: MainCurrency): MainCurrencyCheck {
  if (currency.localHead.toLowerCase() === currency.remoteHead.toLowerCase()) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `local main (${currency.localHead}) is not current with origin/main ` +
      `(${currency.remoteHead}): update local main (e.g. git pull --ff-only on main) and ` +
      'rerun; refusing to branch from a stale base',
  };
}

export async function getRemoteMainHead(execute: CommandExecutor = runCommand): Promise<string> {
  const { stdout } = await execute('git', ['ls-remote', 'origin', 'refs/heads/main']);
  const head = stdout.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-fA-F]{40}$/.test(head)) {
    throw new Error(
      `cannot resolve origin/main HEAD from git ls-remote output: ${stdout.trim().slice(0, 120)}`,
    );
  }
  return head;
}

export interface TicketIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
}

interface GhIssueView {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  labels?: unknown;
}

function parseIssueLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') {
      names.push(entry);
    } else if (typeof entry === 'object' && entry !== null && 'name' in entry) {
      const name: unknown = (entry as { name?: unknown }).name;
      if (typeof name === 'string') {
        names.push(name);
      }
    }
  }
  return names;
}

export function parseIssueView(stdout: string): TicketIssue {
  const parsed = JSON.parse(stdout) as GhIssueView;
  if (typeof parsed.number !== 'number' || typeof parsed.title !== 'string') {
    throw new Error('agent:ticket could not parse the ticket issue (expected number and title)');
  }
  return {
    number: parsed.number,
    title: parsed.title,
    state: typeof parsed.state === 'string' ? parsed.state : '',
    labels: parseIssueLabels(parsed.labels),
  };
}

export type TicketIssueCheck = { ok: true } | { ok: false; reason: string };

// Only approved `ready-for-agent` tickets from the dependency frontier are
// implemented; anything else is a planning/triage matter, not an agent run.
export function checkTicketIssue(issue: TicketIssue): TicketIssueCheck {
  if (issue.state !== 'OPEN') {
    return {
      ok: false,
      reason: `refusing ticket #${String(issue.number)}: state is ${issue.state}, expected OPEN`,
    };
  }
  if (!issue.labels.includes('ready-for-agent')) {
    return {
      ok: false,
      reason: `refusing ticket #${String(issue.number)}: missing the ready-for-agent label`,
    };
  }
  return { ok: true };
}

// The initial push happens before the PR exists, so it cannot go through the
// PR-bound `safePushBranch`; it reuses the same `checkSafePush` guards with
// the intended PR shape (head is this branch, base is `main`) instead of
// reimplementing push safety inconsistently. Later pushes go through
// `review:cycle` and its safe-push path.
export function checkInitialPush(state: StartState): SafePushCheck {
  return checkSafePush({
    currentBranch: state.currentBranch,
    prHead: state.currentBranch,
    prBase: 'main',
    pushTarget: 'origin',
    worktreeClean: state.worktreeClean,
  });
}

export function extractSummaryPath(output: string): string | undefined {
  let found: string | undefined;
  for (const line of output.split('\n')) {
    const path = /Run summary:\s*(\S+)/.exec(line)?.[1];
    if (path !== undefined) {
      found = path;
    }
  }
  return found;
}

export interface WorkerOutput {
  stdout: string;
  stderr: string;
}

export type WorkerRunner = (
  command: string,
  args: readonly string[],
  label: string,
) => Promise<WorkerOutput>;

function defaultWorkerRunner(
  command: string,
  args: readonly string[],
  label: string,
): Promise<WorkerOutput> {
  return runWorkerStream(command, args, { label });
}

export interface AgentTicketDeps {
  execute?: CommandExecutor;
  runWorker?: WorkerRunner;
  runGates?: (execute: CommandExecutor) => Promise<GateResult[]>;
}

export interface AgentTicketResult {
  exitCode: number;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  summaryPath?: string;
  failedStage?: string;
  reason?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorExitCode(error: unknown): number {
  const code: unknown = (error as { code?: unknown }).code;
  return code === 2 ? 2 : 1;
}

function reportDurableState(partial: { branch?: string; prNumber?: number; prUrl?: string }): void {
  const parts: string[] = [];
  if (partial.branch !== undefined) {
    parts.push(`branch=${partial.branch}`);
  }
  if (partial.prNumber !== undefined) {
    parts.push(`pr=#${String(partial.prNumber)}`);
  }
  if (partial.prUrl !== undefined) {
    parts.push(`prUrl=${partial.prUrl}`);
  }
  parts.push('run summary: .review-cycle/latest.json (once review:cycle has run)');
  console.error(`Durable state: ${parts.join(' ')}`);
}

function failResult(stage: string, reason: string, branch?: string): AgentTicketResult {
  return branch === undefined
    ? { exitCode: 1, failedStage: stage, reason }
    : { exitCode: 1, failedStage: stage, reason, branch };
}

export async function runAgentTicket(
  rawTicket: string | undefined,
  deps: AgentTicketDeps = {},
): Promise<AgentTicketResult> {
  const execute = deps.execute ?? runCommand;
  const runWorker = deps.runWorker ?? defaultWorkerRunner;
  const runGates = deps.runGates ?? runQualityGates;

  let ticket: number;
  try {
    ticket = parseTicketArg(rawTicket);
  } catch (error) {
    const reason = errorMessage(error);
    console.error(`AGENT-TICKET BLOCKED (validate): ${reason}`);
    console.error('usage: agent-ticket <issue-number>');
    return failResult('validate', reason);
  }

  let start: StartState;
  try {
    start = {
      currentBranch: await getCurrentBranch(execute),
      worktreeClean: await isWorktreeClean(execute),
    };
  } catch (error) {
    const reason = `cannot validate the starting worktree: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (start-state): ${reason}`);
    return failResult('start-state', reason);
  }
  const startCheck = checkStartState(start);
  if (!startCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (start-state): ${startCheck.reason}`);
    return failResult('start-state', startCheck.reason);
  }

  let mainHead: string;
  let originHead: string;
  try {
    mainHead = await getCurrentHead(execute);
    originHead = await getRemoteMainHead(execute);
  } catch (error) {
    const reason =
      `cannot prove local main is current with origin/main: ${errorMessage(error)}; ` +
      'refusing to start from an unverifiable base';
    console.error(`AGENT-TICKET BLOCKED (start-state): ${reason}`);
    return failResult('start-state', reason);
  }
  const currencyCheck = checkMainCurrency({ localHead: mainHead, remoteHead: originHead });
  if (!currencyCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (start-state): ${currencyCheck.reason}`);
    return failResult('start-state', currencyCheck.reason);
  }

  let issue: TicketIssue;
  try {
    const { stdout } = await execute('gh', [
      'issue',
      'view',
      String(ticket),
      '--json',
      'number,title,state,labels',
    ]);
    issue = parseIssueView(stdout);
  } catch (error) {
    const reason = `cannot read ticket #${String(ticket)}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (ticket): ${reason}`);
    return failResult('ticket', reason);
  }
  if (issue.number !== ticket) {
    const reason = `ticket mismatch: requested #${String(ticket)} but gh returned #${String(issue.number)}`;
    console.error(`AGENT-TICKET BLOCKED (ticket): ${reason}`);
    return failResult('ticket', reason);
  }
  const issueCheck = checkTicketIssue(issue);
  if (!issueCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (ticket): ${issueCheck.reason}`);
    return failResult('ticket', issueCheck.reason);
  }

  const branch = ticketBranchName(ticket, issue.title);
  try {
    await execute('git', ['show-ref', '--verify', `refs/heads/${branch}`]);
    const reason = `${branch} already exists; refusing to reuse or repair an existing branch`;
    console.error(`AGENT-TICKET BLOCKED (branch): ${reason}`);
    return failResult('branch', reason, branch);
  } catch {
    // Absent locally: the expected case, continue.
  }
  try {
    await execute('git', ['checkout', '-b', branch]);
  } catch (error) {
    const reason = `cannot create ticket branch ${branch}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (branch): ${reason}`);
    return failResult('branch', reason, branch);
  }
  console.log(`Created ticket branch ${branch} from main.`);

  // `git checkout -b` does not move HEAD, so the pre-checkout main tip is the
  // baseline the implementation must advance.
  const headBefore = mainHead;
  try {
    await runWorker('opencode', buildImplementArgs(ticket), 'implement');
  } catch (error) {
    const reason = `/implement failed for ticket #${String(ticket)}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET FAILED (implement): ${reason}`);
    reportDurableState({ branch });
    return failResult('implement', reason, branch);
  }
  const headAfter = await getCurrentHead(execute);
  if (headAfter === headBefore) {
    const reason = `/implement produced no local commits on ${branch}`;
    console.error(`AGENT-TICKET FAILED (implement): ${reason}`);
    reportDurableState({ branch });
    return failResult('implement', reason, branch);
  }
  if (!(await isWorktreeClean(execute))) {
    const reason = `/implement left uncommitted changes on ${branch}; refusing to push a dirty worktree`;
    console.error(`AGENT-TICKET FAILED (implement): ${reason}`);
    reportDurableState({ branch });
    return failResult('implement', reason, branch);
  }
  console.log(`Implementation advanced ${branch}: ${headBefore} -> ${headAfter}.`);

  const gates = await runGates(execute);
  for (const gate of gates) {
    console.log(`gate ${gate.name}: ${gate.ok ? 'PASS' : 'FAIL'}`);
  }
  if (!qualityGatesPass(gates)) {
    const reason = 'repository quality gates failed for the implementation HEAD';
    console.error(`AGENT-TICKET BLOCKED (gates): ${reason}.`);
    reportDurableState({ branch });
    return failResult('gates', reason, branch);
  }

  const pushCheck = checkInitialPush({ currentBranch: branch, worktreeClean: true });
  if (!pushCheck.ok) {
    const reason = `initial push refused: ${pushCheck.reason}`;
    console.error(`AGENT-TICKET BLOCKED (push): ${reason}`);
    reportDurableState({ branch });
    return failResult('push', reason, branch);
  }
  try {
    await execute('git', ['push', '-u', 'origin', branch]);
  } catch (error) {
    const reason = `initial push of ${branch} failed: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (push): ${reason}`);
    reportDurableState({ branch });
    return failResult('push', reason, branch);
  }
  console.log(`Pushed ticket branch: origin/${branch}`);

  try {
    await execute('gh', buildPrCreateArgs({ branch, title: issue.title, ticket }));
  } catch (error) {
    const reason = `draft PR creation failed for ${branch}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (pr): ${reason}`);
    reportDurableState({ branch });
    return failResult('pr', reason, branch);
  }
  let prNumber: number;
  let prUrl: string | undefined;
  try {
    const pr = await getPrForBranch(undefined, execute);
    prNumber = pr.number;
    prUrl = pr.url;
  } catch (error) {
    const reason = `draft PR was created but cannot be resolved: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (pr): ${reason}`);
    reportDurableState({ branch });
    return failResult('pr', reason, branch);
  }
  console.log(
    `Draft PR #${String(prNumber)}${prUrl === undefined ? '' : `: ${prUrl}`} (base main).`,
  );

  let review: WorkerOutput;
  try {
    review = await runWorker('npm', buildReviewCycleArgs(), 'review-cycle');
  } catch (error) {
    const exitCode = errorExitCode(error);
    const reason = `review:cycle did not reach READY: ${errorMessage(error)}`;
    console.error(
      `AGENT-TICKET ${exitCode === 2 ? 'ESCALATED' : 'BLOCKED'} (review-cycle): ${reason}`,
    );
    reportDurableState({ branch, prNumber, prUrl });
    return { exitCode, failedStage: 'review-cycle', reason, branch, prNumber, prUrl };
  }
  const summaryPath = extractSummaryPath(review.stdout) ?? '.review-cycle/latest.json';
  console.log('');
  console.log(`READY FOR FINAL ACCEPTANCE\nBranch: ${branch}\nPR: #${String(prNumber)}`);
  console.log(`Run summary: ${summaryPath}`);
  return { exitCode: 0, branch, prNumber, prUrl, summaryPath };
}
