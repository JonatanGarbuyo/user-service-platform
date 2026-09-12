import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
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
import { isWorkerTimeout, timeoutForWorker, type WorkerLabel } from '../review/worker-timeout.js';
import { publishStageStatus, type RunStatusOutcome, type StatusEnv } from '../review/run-status.js';

// Explicit stage names for the durable run-status surface (ticket #31).
// One status comment per agent run is updated as these stages advance so the
// current stage and terminal outcome are visible from GitHub mobile/web
// without terminal polling.
export const TICKET_STAGE_NAMES = [
  'validation',
  'implementation',
  'gates',
  'push',
  'PR creation',
  'review',
  'final acceptance-ready',
] as const;

export type TicketStageName = (typeof TICKET_STAGE_NAMES)[number];

// Terminal outcome record (ticket #31). Every terminal state — including
// pre-review failures where `review:cycle` never ran and no
// `.review-cycle/latest.json` exists — records its outcome, stage, and
// reason at this path so the workflow terminal step can distinguish TIMEOUT
// from generic BLOCKED without log polling. Deterministic
// repository-owned metadata only, never transcripts or secrets.
export const AGENT_TICKET_OUTCOME_PATH = '.agent-ticket/outcome.json';

export type AgentTicketStatusOutcome = 'READY' | 'BLOCKED' | 'NEEDS-DECISION' | 'TIMEOUT';

export interface AgentTicketOutcome {
  outcome: AgentTicketStatusOutcome;
  stage: string;
  reason: string;
  startedAt: string;
  completedStages: string[];
  actionRequired?: string;
}

export interface AgentTicketTerminal {
  exitCode: number;
  failedStage?: string;
  timedOut?: boolean;
}

function stageForFailedStage(failedStage: string | undefined): string {
  if (failedStage === 'implement') {
    return 'implementation';
  }
  if (failedStage === 'gates') {
    return 'gates';
  }
  if (failedStage === 'push') {
    return 'push';
  }
  if (failedStage === 'pr') {
    return 'PR creation';
  }
  if (failedStage === 'review-cycle') {
    return 'review';
  }
  if (
    failedStage === 'validate' ||
    failedStage === 'start-state' ||
    failedStage === 'ticket' ||
    failedStage === 'branch'
  ) {
    return 'validation';
  }
  return 'run';
}

export function terminalOutcomeFor(result: AgentTicketTerminal): {
  outcome: AgentTicketStatusOutcome;
  stage: string;
} {
  if (result.exitCode === 0) {
    return { outcome: 'READY', stage: 'final acceptance-ready' };
  }
  // A timeout stays a timeout regardless of the accompanying exit code.
  if (result.timedOut === true) {
    return { outcome: 'TIMEOUT', stage: stageForFailedStage(result.failedStage) };
  }
  if (result.exitCode === 2) {
    return { outcome: 'NEEDS-DECISION', stage: stageForFailedStage(result.failedStage) };
  }
  return { outcome: 'BLOCKED', stage: stageForFailedStage(result.failedStage) };
}

export interface OutcomePersistDeps {
  mkdir?: (dir: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (path: string, contents: string) => Promise<unknown>;
  path?: string;
}

export async function writeAgentTicketOutcome(
  input: Omit<AgentTicketOutcome, 'startedAt' | 'completedStages'> & {
    startedAt?: string;
    completedStages?: readonly string[];
  },
  deps: OutcomePersistDeps = {},
): Promise<string> {
  const path = deps.path ?? AGENT_TICKET_OUTCOME_PATH;
  const mkdir =
    deps.mkdir ?? ((dir: string, options: { recursive: boolean }) => fs.mkdir(dir, options));
  const writeFile =
    deps.writeFile ?? ((file: string, contents: string) => fs.writeFile(file, contents, 'utf8'));
  const record: AgentTicketOutcome = {
    outcome: input.outcome,
    stage: input.stage,
    reason: input.reason,
    startedAt: input.startedAt ?? new Date().toISOString(),
    completedStages: input.completedStages === undefined ? [] : [...input.completedStages],
  };
  if (input.actionRequired !== undefined) {
    record.actionRequired = input.actionRequired;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

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
  label: WorkerLabel,
): Promise<WorkerOutput> {
  // Bounded execution (ticket #31): implement and review-cycle workers share
  // the same timeout semantics as local orchestration so a hung worker is
  // terminated with a distinguishable TIMEOUT instead of hanging the runner.
  return runWorkerStream(command, args, { label, timeoutMs: timeoutForWorker(label) });
}

export interface AgentTicketDeps {
  execute?: CommandExecutor;
  runWorker?: WorkerRunner;
  runGates?: (execute: CommandExecutor) => Promise<GateResult[]>;
  // Stage reporter for the durable run-status surface (ticket #31). Called
  // once per reached stage, in order; defaults to silence so local runs stay
  // quiet and existing callers are unaffected.
  onStage?: (stage: TicketStageName) => void;
  // Durable status comment owned by the calling workflow (ticket #31). When
  // present, each reached stage and the terminal outcome PATCH that single
  // comment; when absent, status stays silent. Publication is best-effort and
  // never changes the orchestration outcome.
  status?: StatusEnv;
  // Terminal outcome recording (ticket #31). Defaults to silence; the CLI
  // entrypoint wires the repository-local outcome file read by the workflow
  // terminal step, and tests inject a captor.
  recordOutcome?: (record: AgentTicketOutcome) => Promise<void> | void;
}

export interface AgentTicketResult {
  exitCode: number;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  summaryPath?: string;
  failedStage?: string;
  reason?: string;
  // True when the failure was a bounded worker timeout, distinct from model,
  // gate, CI, human-decision, stale-HEAD, or cancellation failures.
  timedOut?: boolean;
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

function failResult(
  stage: string,
  reason: string,
  branch?: string,
  timedOut?: boolean,
): AgentTicketResult {
  const base =
    branch === undefined
      ? { exitCode: 1, failedStage: stage, reason }
      : { exitCode: 1, failedStage: stage, reason, branch };
  return timedOut ? { ...base, timedOut: true } : base;
}

export async function runAgentTicket(
  rawTicket: string | undefined,
  deps: AgentTicketDeps = {},
): Promise<AgentTicketResult> {
  const execute = deps.execute ?? runCommand;
  const runWorker = deps.runWorker ?? defaultWorkerRunner;
  const runGates = deps.runGates ?? runQualityGates;
  const reportStage = (stage: TicketStageName): void => {
    deps.onStage?.(stage);
  };

  // Durable status publication (ticket #31): the calling workflow owns one
  // status comment per run and passes its routing here. Each reached stage
  // and the terminal outcome PATCH that same comment with deterministic
  // repository-owned metadata. Absent routing means a local run: silent.
  const startedAtIso = new Date().toISOString();
  const completedStages: string[] = [];
  const statusTarget = deps.status;

  function workerForStage(stage: TicketStageName): string | undefined {
    if (stage === 'implementation') {
      return 'implement';
    }
    if (stage === 'review') {
      return 'review-cycle';
    }
    return undefined;
  }

  async function publishStage(
    stage: TicketStageName,
    options: {
      branch: string;
      head?: string;
      outcome?: RunStatusOutcome;
      reason?: string;
      actionRequired?: string;
    },
  ): Promise<void> {
    if (statusTarget === undefined || ticketNumber === undefined) {
      return;
    }
    let head = options.head;
    if (head === undefined) {
      try {
        head = await getCurrentHead(execute);
      } catch {
        head = '(unknown)';
      }
    }
    const worker = workerForStage(stage);
    await publishStageStatus(execute, statusTarget, {
      target: `issue #${String(ticketNumber)}`,
      branch: options.branch,
      head,
      currentStage: stage,
      completedStages: [...completedStages],
      startedAt: startedAtIso,
      ...(worker === undefined ? {} : { worker }),
      ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.actionRequired === undefined ? {} : { actionRequired: options.actionRequired }),
    });
  }

  // Terminal outcome recording (ticket #31): every terminal state is recorded
  // best-effort through the injected recorder so the workflow terminal step
  // can report the exact outcome even when `review:cycle` never ran. The CLI
  // entrypoint wires the repository-local outcome file; tests inject a captor
  // or stay silent. Recording never changes the result itself.
  async function recordTerminal(result: AgentTicketResult, actionRequired?: string): Promise<void> {
    try {
      const mapped = terminalOutcomeFor(result);
      await deps.recordOutcome?.({
        outcome: mapped.outcome,
        stage: mapped.stage,
        reason: result.reason ?? 'terminal state',
        startedAt: startedAtIso,
        completedStages: [...completedStages],
        ...(actionRequired === undefined ? {} : { actionRequired }),
      });
    } catch {
      // Best-effort: recording never changes the terminal outcome.
    }
  }

  // Terminal publication always carries an attention outcome except READY:
  // BLOCKED, NEEDS-DECISION, and TIMEOUT mention the owner with stage, reason,
  // and the exact action required so GitHub Mobile pushes.
  async function terminal(
    result: AgentTicketResult,
    stage: TicketStageName,
    branch: string,
    outcome: RunStatusOutcome,
    actionRequired: string,
    head?: string,
  ): Promise<AgentTicketResult> {
    if (result.reason !== undefined) {
      await publishStage(stage, { branch, head, outcome, reason: result.reason, actionRequired });
    }
    await recordTerminal(result, actionRequired);
    return result;
  }

  reportStage('validation');
  let ticket: number;
  let ticketNumber: number | undefined;
  try {
    ticket = parseTicketArg(rawTicket);
    ticketNumber = ticket;
  } catch (error) {
    const reason = errorMessage(error);
    console.error(`AGENT-TICKET BLOCKED (validate): ${reason}`);
    console.error('usage: agent-ticket <issue-number>');
    const result = failResult('validate', reason);
    await recordTerminal(
      result,
      'Provide a single positive integer issue number: npm run agent:ticket -- <issue>.',
    );
    return result;
  }

  const earlyTerminal = async (
    result: AgentTicketResult,
    actionRequired: string,
  ): Promise<AgentTicketResult> =>
    terminal(result, 'validation', '(starting)', 'BLOCKED', actionRequired, '(starting)');

  let start: StartState;
  try {
    start = {
      currentBranch: await getCurrentBranch(execute),
      worktreeClean: await isWorktreeClean(execute),
    };
  } catch (error) {
    const reason = `cannot validate the starting worktree: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (start-state): ${reason}`);
    return earlyTerminal(
      failResult('start-state', reason),
      'Start from a clean, current main worktree, then rerun /agent-ticket.',
    );
  }
  const startCheck = checkStartState(start);
  if (!startCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (start-state): ${startCheck.reason}`);
    return earlyTerminal(
      failResult('start-state', startCheck.reason),
      'Start from a clean, current main worktree, then rerun /agent-ticket.',
    );
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
    return earlyTerminal(
      failResult('start-state', reason),
      'Start from a clean, current main worktree, then rerun /agent-ticket.',
    );
  }
  const currencyCheck = checkMainCurrency({ localHead: mainHead, remoteHead: originHead });
  if (!currencyCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (start-state): ${currencyCheck.reason}`);
    return earlyTerminal(
      failResult('start-state', currencyCheck.reason),
      'Start from a clean, current main worktree, then rerun /agent-ticket.',
    );
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
    return earlyTerminal(
      failResult('ticket', reason),
      'Use an OPEN ready-for-agent ticket, then rerun /agent-ticket.',
    );
  }
  if (issue.number !== ticket) {
    const reason = `ticket mismatch: requested #${String(ticket)} but gh returned #${String(issue.number)}`;
    console.error(`AGENT-TICKET BLOCKED (ticket): ${reason}`);
    return earlyTerminal(
      failResult('ticket', reason),
      'Use an OPEN ready-for-agent ticket, then rerun /agent-ticket.',
    );
  }
  const issueCheck = checkTicketIssue(issue);
  if (!issueCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (ticket): ${issueCheck.reason}`);
    return earlyTerminal(
      failResult('ticket', issueCheck.reason),
      'Use an OPEN ready-for-agent ticket, then rerun /agent-ticket.',
    );
  }

  const branch = ticketBranchName(ticket, issue.title);
  try {
    await execute('git', ['show-ref', '--verify', `refs/heads/${branch}`]);
    const reason = `${branch} already exists; refusing to reuse or repair an existing branch`;
    console.error(`AGENT-TICKET BLOCKED (branch): ${reason}`);
    return await earlyTerminal(
      failResult('branch', reason, branch),
      'Remove or rename the conflicting branch, then rerun /agent-ticket.',
    );
  } catch {
    // Absent locally: the expected case, continue.
  }
  try {
    await execute('git', ['checkout', '-b', branch]);
  } catch (error) {
    const reason = `cannot create ticket branch ${branch}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (branch): ${reason}`);
    return earlyTerminal(
      failResult('branch', reason, branch),
      'Remove or rename the conflicting branch, then rerun /agent-ticket.',
    );
  }
  console.log(`Created ticket branch ${branch} from main.`);

  // `git checkout -b` does not move HEAD, so the pre-checkout main tip is the
  // baseline the implementation must advance.
  const headBefore = mainHead;
  reportStage('implementation');
  await publishStage('implementation', { branch, head: headBefore });
  try {
    await runWorker('opencode', buildImplementArgs(ticket), 'implement');
  } catch (error) {
    const timedOut = isWorkerTimeout(error);
    const reason = timedOut
      ? `/implement timed out for ticket #${String(ticket)}: ${errorMessage(error)}`
      : `/implement failed for ticket #${String(ticket)}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET ${timedOut ? 'TIMEOUT' : 'FAILED'} (implement): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('implement', reason, branch, timedOut ? true : undefined),
      'implementation',
      branch,
      timedOut ? 'TIMEOUT' : 'BLOCKED',
      timedOut
        ? 'The implement worker exceeded its bound; rerun /agent-ticket once the runner is free.'
        : 'Inspect the implement worker output, then rerun /agent-ticket.',
      headBefore,
    );
  }
  const headAfter = await getCurrentHead(execute);
  if (headAfter === headBefore) {
    const reason = `/implement produced no local commits on ${branch}`;
    console.error(`AGENT-TICKET FAILED (implement): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('implement', reason, branch),
      'implementation',
      branch,
      'BLOCKED',
      'Inspect the ticket branch state, then rerun /agent-ticket.',
      headBefore,
    );
  }
  if (!(await isWorktreeClean(execute))) {
    const reason = `/implement left uncommitted changes on ${branch}; refusing to push a dirty worktree`;
    console.error(`AGENT-TICKET FAILED (implement): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('implement', reason, branch),
      'implementation',
      branch,
      'BLOCKED',
      'Inspect the ticket branch state, then rerun /agent-ticket.',
      headAfter,
    );
  }
  console.log(`Implementation advanced ${branch}: ${headBefore} -> ${headAfter}.`);
  completedStages.push('implementation');

  reportStage('gates');
  await publishStage('gates', { branch, head: headAfter });
  const gates = await runGates(execute);
  for (const gate of gates) {
    console.log(`gate ${gate.name}: ${gate.ok ? 'PASS' : 'FAIL'}`);
  }
  if (!qualityGatesPass(gates)) {
    const reason = 'repository quality gates failed for the implementation HEAD';
    console.error(`AGENT-TICKET BLOCKED (gates): ${reason}.`);
    reportDurableState({ branch });
    return terminal(
      failResult('gates', reason, branch),
      'gates',
      branch,
      'BLOCKED',
      'Fix the failing gate locally, then rerun /agent-ticket.',
      headAfter,
    );
  }
  completedStages.push('gates');

  reportStage('push');
  await publishStage('push', { branch, head: headAfter });
  const pushCheck = checkInitialPush({ currentBranch: branch, worktreeClean: true });
  if (!pushCheck.ok) {
    const reason = `initial push refused: ${pushCheck.reason}`;
    console.error(`AGENT-TICKET BLOCKED (push): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('push', reason, branch),
      'push',
      branch,
      'BLOCKED',
      'Inspect push permissions and branch state, then rerun /agent-ticket.',
      headAfter,
    );
  }
  try {
    await execute('git', ['push', '-u', 'origin', branch]);
  } catch (error) {
    const reason = `initial push of ${branch} failed: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (push): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('push', reason, branch),
      'push',
      branch,
      'BLOCKED',
      'Inspect push permissions and branch state, then rerun /agent-ticket.',
      headAfter,
    );
  }
  console.log(`Pushed ticket branch: origin/${branch}`);
  completedStages.push('push');

  reportStage('PR creation');
  await publishStage('PR creation', { branch, head: headAfter });
  try {
    await execute('gh', buildPrCreateArgs({ branch, title: issue.title, ticket }));
  } catch (error) {
    const reason = `draft PR creation failed for ${branch}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (pr): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('pr', reason, branch),
      'PR creation',
      branch,
      'BLOCKED',
      'Inspect PR creation permissions, then rerun /agent-ticket.',
      headAfter,
    );
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
    return terminal(
      failResult('pr', reason, branch),
      'PR creation',
      branch,
      'BLOCKED',
      'Inspect PR creation permissions, then rerun /agent-ticket.',
      headAfter,
    );
  }
  console.log(
    `Draft PR #${String(prNumber)}${prUrl === undefined ? '' : `: ${prUrl}`} (base main).`,
  );
  completedStages.push('PR creation');

  let review: WorkerOutput;
  reportStage('review');
  await publishStage('review', { branch, head: headAfter });
  try {
    review = await runWorker('npm', buildReviewCycleArgs(), 'review-cycle');
  } catch (error) {
    const exitCode = errorExitCode(error);
    const timedOut = isWorkerTimeout(error);
    const reason = timedOut
      ? `review:cycle timed out: ${errorMessage(error)}`
      : `review:cycle did not reach READY: ${errorMessage(error)}`;
    console.error(
      `AGENT-TICKET ${timedOut ? 'TIMEOUT' : exitCode === 2 ? 'ESCALATED' : 'BLOCKED'} (review-cycle): ${reason}`,
    );
    reportDurableState({ branch, prNumber, prUrl });
    const outcome: RunStatusOutcome = timedOut
      ? 'TIMEOUT'
      : exitCode === 2
        ? 'NEEDS-DECISION'
        : 'BLOCKED';
    const actionRequired =
      outcome === 'NEEDS-DECISION'
        ? 'A product, architecture, or contract decision is required before automation can continue.'
        : outcome === 'TIMEOUT'
          ? 'The review worker exceeded its bound; rerun once the runner is free.'
          : 'Inspect .review-cycle/latest.json, then rerun.';
    return terminal(
      {
        exitCode,
        failedStage: 'review-cycle',
        reason,
        branch,
        prNumber,
        prUrl,
        ...(timedOut ? { timedOut: true } : {}),
      },
      'review',
      branch,
      outcome,
      actionRequired,
    );
  }
  const summaryPath = extractSummaryPath(review.stdout) ?? '.review-cycle/latest.json';
  reportStage('final acceptance-ready');
  completedStages.push('review');
  await publishStage('final acceptance-ready', {
    branch,
    outcome: 'READY',
    reason: 'ready for final acceptance',
  });
  console.log('');
  console.log(`READY FOR FINAL ACCEPTANCE\nBranch: ${branch}\nPR: #${String(prNumber)}`);
  console.log(`Run summary: ${summaryPath}`);
  const success: AgentTicketResult = { exitCode: 0, branch, prNumber, prUrl, summaryPath };
  await recordTerminal(success);
  return success;
}
