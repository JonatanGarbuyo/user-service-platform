export type AgentCommand = 'agent-ticket' | 'agent-fix-cycle';

export const AGENT_COMMANDS: readonly AgentCommand[] = ['agent-ticket', 'agent-fix-cycle'];

function commandForToken(token: string): AgentCommand | undefined {
  if (token === '/agent-ticket') {
    return 'agent-ticket';
  }
  if (token === '/agent-fix-cycle') {
    return 'agent-fix-cycle';
  }
  return undefined;
}

// Fixed-command parsing (ticket #29). Comment text only selects from a small
// allowlist of exact commands and is never evaluated as shell, arguments,
// filenames, refs, or prompts. The first non-empty line must exactly equal one
// allowlisted command; anything with arguments, shell metacharacters, wrong
// case, or more than one command line is refused as ambiguous.
export function parseAgentCommand(body: string | undefined | null): AgentCommand | undefined {
  if (typeof body !== 'string') {
    return undefined;
  }
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) {
    return undefined;
  }
  const first = lines[0];
  if (first === undefined) {
    return undefined;
  }
  const selected = commandForToken(first);
  if (selected === undefined) {
    return undefined;
  }
  const matches = lines.filter((line) => commandForToken(line) !== undefined);
  if (matches.length !== 1) {
    return undefined;
  }
  if (!AGENT_COMMANDS.includes(selected)) {
    return undefined;
  }
  return selected;
}

const AUTHORIZED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// Only repository-owned actors may trigger remote agent runs. GitHub
// `author_association` values outside OWNER/MEMBER/COLLABORATOR are refused.
export function isAuthorizedAssociation(association: string | undefined | null): boolean {
  if (typeof association !== 'string') {
    return false;
  }
  return AUTHORIZED_ASSOCIATIONS.has(association);
}

export interface FixCyclePrState {
  isPullRequest: boolean;
  state: string;
  isFork: boolean;
  baseRef: string;
  headSha: string;
}

export type FixCyclePrCheck = { ok: true } | { ok: false; reason: string };

function isExactHeadSha(headSha: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(headSha);
}

// Same-repository PRs targeting `main` only; forks, unsafe bases/refs, and
// ambiguous state are refused before any mutation.
export function checkFixCyclePr(state: FixCyclePrState): FixCyclePrCheck {
  if (!state.isPullRequest) {
    return { ok: false, reason: 'refusing /agent-fix-cycle: comment is not on a pull request' };
  }
  if (state.state !== 'OPEN') {
    return {
      ok: false,
      reason: `refusing /agent-fix-cycle: PR state is ${state.state}, expected OPEN`,
    };
  }
  if (state.isFork) {
    return { ok: false, reason: 'refusing /agent-fix-cycle: fork PRs are not supported' };
  }
  if (state.baseRef !== 'main') {
    return {
      ok: false,
      reason: `refusing /agent-fix-cycle: PR base must be main, got ${state.baseRef}`,
    };
  }
  if (!isExactHeadSha(state.headSha)) {
    return {
      ok: false,
      reason: 'refusing /agent-fix-cycle: PR head SHA is missing or ambiguous',
    };
  }
  return { ok: true };
}

export interface TicketIssueState {
  isPullRequest: boolean;
  state: string;
  labels: readonly string[];
}

export type TicketIssueCheck = { ok: true } | { ok: false; reason: string };

// Remote ticket launches reuse the local `agent:ticket` frontier rule: only
// OPEN `ready-for-agent` issues, never pull requests.
export function checkTicketIssue(state: TicketIssueState): TicketIssueCheck {
  if (state.isPullRequest) {
    return { ok: false, reason: 'refusing /agent-ticket: comment is on a pull request' };
  }
  if (state.state !== 'OPEN') {
    return {
      ok: false,
      reason: `refusing /agent-ticket: issue state is ${state.state}, expected OPEN`,
    };
  }
  if (!state.labels.includes('ready-for-agent')) {
    return { ok: false, reason: 'refusing /agent-ticket: missing the ready-for-agent label' };
  }
  return { ok: true };
}

// Concurrency-lock by PR/issue so duplicate commands cannot race on the same
// branch. Mirrors the `concurrency.group` values used in the workflows.
export function concurrencyGroupFor(command: AgentCommand, number: number): string {
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(
      `concurrency group requires a positive integer run number, got ${String(number)}`,
    );
  }
  if (command === 'agent-ticket') {
    return `agent-ticket-issue-${String(number)}`;
  }
  return `agent-fix-cycle-pr-${String(number)}`;
}
