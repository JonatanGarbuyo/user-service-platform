import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isAuthorizedAssociation, parseAgentCommand } from '../../scripts/agent/command-guard.js';
import { CHECK_POLL_ATTEMPTS, CHECK_POLL_DELAY_MS } from '../../scripts/review/pr-checks.js';
import {
  APPROVE_BOT_LOGIN,
  APPROVE_TRUSTED_PUBLISHER_APP_SLUG,
  buildPrIssueFetchArgs,
  buildTicketCommentsArgs,
  collectBotHandoffMarkers,
  decideAgentCiApproval,
  evaluateAgentCiApproval,
  parsePrIssueAppSlug,
  parseTicketCommentsOutput,
  type AgentCiProvenance,
} from '../../scripts/review/approve-agent-ci.js';
import {
  formatTrustedHandoffMarker,
  isHandoffCovering,
  parseTrustedHandoffMarker,
  type TrustedHandoffMarker,
} from '../../scripts/review/workflow-handoff.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';

// Seam under test (ticket #82): GitHub Actions noise reduction and
// trusted-handoff CI provenance.
//
// These tests read the real workflow files at their real locations (parsed
// structurally, ignoring comments) and evaluate the real job/checkout
// expressions with GitHub Actions semantics against independent fixtures.
// Commented-out text must never satisfy a contract, and no production helper
// exists solely for these tests: the evaluator below is a generic Actions
// expression subset, not a copy of any workflow predicate.

// ---------------------------------------------------------------------------
// Structural YAML readers (real parser, location-specific)
// ---------------------------------------------------------------------------
//
// Every reader below parses the workflow with a real YAML parser and selects
// the actual job/step/trigger nodes. Comments never satisfy a contract
// because the parser discards them. Regex/token-presence substitutes are
// rejected: moving `jobs.run.if` onto a step, or moving checkout's
// `with.ref` onto another step, must not preserve the extracted value.

function readWorkflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

type WorkflowDocument = Record<string, unknown>;

function parseWorkflowDocument(text: string): WorkflowDocument {
  const parsed: unknown = parseYaml(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('unsupported workflow: top-level mapping expected');
  }
  return parsed as WorkflowDocument;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function ifToString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

// The job-level prefilter lives at exactly `jobs.run.if`. Step-level `if:`
// conditions under `jobs.run.steps[]` must never satisfy this reader.
function extractJobIf(workflowText: string): string | undefined {
  const doc = parseWorkflowDocument(workflowText);
  const jobs = asRecord(doc.jobs);
  const run = jobs === undefined ? undefined : asRecord(jobs.run);
  if (run === undefined) {
    return undefined;
  }
  return ifToString(run.if);
}

function unwrapExpression(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('${{') && trimmed.endsWith('}}')) {
    return trimmed.slice(3, -2).trim();
  }
  return trimmed;
}

function extractCiCheckoutRef(ciText: string): string | undefined {
  // Location-specific: the `ref` of the step whose `uses` is
  // `actions/checkout`. A `ref` on any other step (for example setup-node)
  // must not satisfy this reader.
  const doc = parseWorkflowDocument(ciText);
  const jobs = asRecord(doc.jobs);
  const gates = jobs === undefined ? undefined : asRecord(jobs.gates);
  const steps = gates === undefined ? undefined : gates.steps;
  if (!Array.isArray(steps)) {
    return undefined;
  }
  for (const entry of steps) {
    const step = asRecord(entry);
    if (step === undefined) {
      continue;
    }
    const uses = step.uses;
    if (typeof uses !== 'string' || !uses.includes('actions/checkout@')) {
      continue;
    }
    const withBlock = asRecord(step.with);
    if (withBlock === undefined) {
      return undefined;
    }
    return ifToString(withBlock.ref);
  }
  return undefined;
}

function extractCiPushBranches(ciText: string): string[] {
  const doc = parseWorkflowDocument(ciText);
  const onBlock = asRecord(doc.on);
  const push = onBlock === undefined ? undefined : asRecord(onBlock.push);
  const branches = push === undefined ? undefined : push.branches;
  if (typeof branches === 'string') {
    return [branches];
  }
  if (Array.isArray(branches)) {
    return branches.filter((entry): entry is string => typeof entry === 'string');
  }
  return [];
}

function hasPullRequestTrigger(ciText: string): boolean {
  const doc = parseWorkflowDocument(ciText);
  const onBlock = asRecord(doc.on);
  return onBlock?.pull_request !== undefined;
}

function extractScheduleCron(approverText: string): string | undefined {
  const doc = parseWorkflowDocument(approverText);
  const onBlock = asRecord(doc.on);
  const schedule = onBlock === undefined ? undefined : onBlock.schedule;
  if (!Array.isArray(schedule)) {
    return undefined;
  }
  for (const entry of schedule) {
    const item = asRecord(entry);
    if (item !== undefined && typeof item.cron === 'string') {
      return item.cron;
    }
  }
  return undefined;
}

function cronIntervalMinutes(cron: string): number | undefined {
  const every = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(cron.trim());
  if (every !== null) {
    return Number.parseInt(every[1] ?? '', 10);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bounded GitHub Actions expression evaluator (tested syntax only)
// ---------------------------------------------------------------------------

type ActionsValue = unknown;

interface Token {
  kind:
    | 'lparen'
    | 'rparen'
    | 'not'
    | 'and'
    | 'or'
    | 'eq'
    | 'neq'
    | 'string'
    | 'number'
    | 'ident'
    | 'true'
    | 'false'
    | 'null';
  text: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const push = (kind: Token['kind'], text: string): void => {
    tokens.push({ kind, text });
  };
  while (index < input.length) {
    const rest = input.slice(index);
    if (/^\s+/.test(rest)) {
      index += /^\s+/.exec(rest)?.[0].length ?? 0;
      continue;
    }
    if (rest.startsWith('&&')) {
      push('and', '&&');
      index += 2;
      continue;
    }
    if (rest.startsWith('||')) {
      push('or', '||');
      index += 2;
      continue;
    }
    if (rest.startsWith('==')) {
      push('eq', '==');
      index += 2;
      continue;
    }
    if (rest.startsWith('!=')) {
      push('neq', '!=');
      index += 2;
      continue;
    }
    const single = rest[0];
    if (single === '(') {
      push('lparen', '(');
      index += 1;
      continue;
    }
    if (single === ')') {
      push('rparen', ')');
      index += 1;
      continue;
    }
    if (single === '!') {
      push('not', '!');
      index += 1;
      continue;
    }
    if (single === "'") {
      let cursor = 1;
      let value = '';
      let closed = false;
      while (index + cursor < input.length) {
        const char: string | undefined = input[index + cursor];
        if (char === undefined) {
          break;
        }
        if (char === "'") {
          if (input[index + cursor + 1] === "'") {
            value += "'";
            cursor += 2;
            continue;
          }
          closed = true;
          cursor += 1;
          break;
        }
        value += char;
        cursor += 1;
      }
      if (!closed) {
        throw new Error(`unsupported expression: unterminated string in ${input}`);
      }
      push('string', value);
      index += cursor;
      continue;
    }
    const numberMatch = /^[0-9]+(\.[0-9]+)?/.exec(rest);
    if (numberMatch !== null) {
      push('number', numberMatch[0]);
      index += numberMatch[0].length;
      continue;
    }
    const identMatch = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(rest);
    if (identMatch !== null) {
      const word = identMatch[0];
      if (word === 'true') {
        push('true', word);
      } else if (word === 'false') {
        push('false', word);
      } else if (word === 'null') {
        push('null', word);
      } else {
        push('ident', word);
      }
      index += word.length;
      continue;
    }
    throw new Error(`unsupported expression syntax near ${JSON.stringify(rest.slice(0, 12))}`);
  }
  return tokens;
}

function isTruthyValue(value: ActionsValue): boolean {
  if (value === false || value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value !== '';
  }
  if (typeof value === 'number') {
    return value !== 0 && !Number.isNaN(value);
  }
  return true;
}

function actionsEqual(left: ActionsValue, right: ActionsValue): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase();
  }
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    return leftNull && rightNull;
  }
  return left === right;
}

function lookupPath(context: Record<string, ActionsValue>, path: string): ActionsValue {
  const parts = path.split('.');
  let current: ActionsValue = context;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, ActionsValue>)[part];
  }
  return current;
}

class ExpressionParser {
  private position = 0;

  public constructor(
    private readonly tokens: readonly Token[],
    private readonly context: Record<string, ActionsValue>,
    private readonly source: string,
  ) {}

  public parse(): ActionsValue {
    const value = this.parseOr();
    if (this.position !== this.tokens.length) {
      throw new Error(`unsupported expression: unexpected trailing input in ${this.source}`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private consume(kind: Token['kind']): Token {
    const token = this.tokens[this.position];
    if (token?.kind !== kind) {
      throw new Error(`unsupported expression: expected ${kind} in ${this.source}`);
    }
    this.position += 1;
    return token;
  }

  private parseOr(): ActionsValue {
    let left = this.parseAnd();
    while (this.peek()?.kind === 'or') {
      this.consume('or');
      const right = this.parseAnd();
      left = isTruthyValue(left) ? left : right;
    }
    return left;
  }

  private parseAnd(): ActionsValue {
    let left = this.parseEquality();
    while (this.peek()?.kind === 'and') {
      this.consume('and');
      const right = this.parseEquality();
      left = isTruthyValue(left) ? right : left;
    }
    return left;
  }

  private parseEquality(): ActionsValue {
    let left = this.parseUnary();
    for (;;) {
      const next = this.peek();
      if (next?.kind === 'eq') {
        this.consume('eq');
        left = actionsEqual(left, this.parseUnary());
      } else if (next?.kind === 'neq') {
        this.consume('neq');
        left = !actionsEqual(left, this.parseUnary());
      } else {
        return left;
      }
    }
  }

  private parseUnary(): ActionsValue {
    if (this.peek()?.kind === 'not') {
      this.consume('not');
      return !isTruthyValue(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ActionsValue {
    const token = this.peek();
    if (token === undefined) {
      throw new Error(`unsupported expression: unexpected end in ${this.source}`);
    }
    if (token.kind === 'lparen') {
      this.consume('lparen');
      const value = this.parseOr();
      this.consume('rparen');
      return value;
    }
    if (token.kind === 'true') {
      this.consume('true');
      return true;
    }
    if (token.kind === 'false') {
      this.consume('false');
      return false;
    }
    if (token.kind === 'null') {
      this.consume('null');
      return null;
    }
    if (token.kind === 'string') {
      this.consume('string');
      return token.text;
    }
    if (token.kind === 'number') {
      this.consume('number');
      return Number.parseFloat(token.text);
    }
    if (token.kind === 'ident') {
      this.consume('ident');
      if (this.peek()?.kind === 'lparen') {
        throw new Error(`unsupported expression: functions not supported in ${this.source}`);
      }
      const [root = ''] = token.text.split('.');
      if (!(root in this.context) && root !== 'github') {
        throw new Error(`unsupported expression: unknown context ${token.text}`);
      }
      return lookupPath(this.context, token.text);
    }
    throw new Error(`unsupported expression: unexpected ${token.kind} in ${this.source}`);
  }
}

function evaluateActionsExpression(
  raw: string,
  context: Record<string, ActionsValue>,
): ActionsValue {
  const inner = unwrapExpression(raw);
  if (inner === '') {
    throw new Error('unsupported expression: empty expression');
  }
  return new ExpressionParser(tokenize(inner), context, raw).parse();
}

function evaluateJobEligible(rawIf: string, context: Record<string, ActionsValue>): boolean {
  return isTruthyValue(evaluateActionsExpression(rawIf, context));
}

// ---------------------------------------------------------------------------
// Independent fixtures (never copied from workflow predicates)
// ---------------------------------------------------------------------------

const TICKET = 82;
const PR_NUMBER = 109;
const BRANCH = 'ticket/82-reduce-github-actions-noise-and-fix-trusted-handoff-ci-prove';
const PR_TITLE = 'Reduce GitHub Actions noise and fix trusted-handoff CI provenance (#82)';
const PR_BODY = 'Automated implementation of #82 via `npm run agent:ticket`.';
const REPO = 'JonatanGarbuyo/user-service-platform';
const PR_HEAD = 'c'.repeat(40);
const HANDOFF_HEAD = 'd'.repeat(40);
const BASE_SHA = 'e'.repeat(40);
const MERGE_SHA = 'f'.repeat(40);
const PUSH_SHA = 'a'.repeat(40);
const WORKFLOW_FILES = [
  '.github/workflows/agent-fix-cycle.yml',
  '.github/workflows/agent-ticket.yml',
  '.github/workflows/approve-agent-ci.yml',
  '.github/workflows/ci.yml',
];

function jobContext(options: {
  body: string;
  association: string;
  isPr: boolean;
}): Record<string, ActionsValue> {
  return {
    github: {
      event: {
        issue: { number: TICKET, pull_request: options.isPr ? { number: PR_NUMBER } : null },
        comment: { body: options.body, author_association: options.association },
      },
    },
  };
}

function checkoutContext(kind: 'pull_request' | 'push'): Record<string, ActionsValue> {
  if (kind === 'pull_request') {
    return {
      github: {
        event_name: 'pull_request',
        sha: MERGE_SHA,
        event: { pull_request: { head: { sha: PR_HEAD } } },
      },
    };
  }
  return { github: { event_name: 'push', sha: PUSH_SHA, event: {} } };
}

function botHandoffMarker(): TrustedHandoffMarker {
  const raw = formatTrustedHandoffMarker({
    ticket: TICKET,
    branch: BRANCH,
    base: BASE_SHA,
    head: HANDOFF_HEAD,
    files: WORKFLOW_FILES,
  });
  const parsed = parseTrustedHandoffMarker(raw);
  if (parsed === null) {
    throw new Error('test setup: handoff marker round-trip failed');
  }
  return parsed;
}

function handoffProvenance(overrides: Partial<AgentCiProvenance> = {}): AgentCiProvenance {
  return {
    workflowName: 'ci',
    runConclusion: 'action_required',
    associatedPrCount: 1,
    prNumber: PR_NUMBER,
    prState: 'open',
    prBaseRef: 'main',
    prHeadRef: BRANCH,
    prHeadSha: PR_HEAD,
    prAuthorLogin: 'JonatanGarbuyo',
    prHeadRepo: REPO,
    prBaseRepo: REPO,
    prTitle: PR_TITLE,
    prBody: PR_BODY,
    runHeadSha: PR_HEAD,
    issueNumber: TICKET,
    issueState: 'open',
    issueLabels: ['ready-for-agent'],
    issueIsPullRequest: false,
    changedFiles: [...WORKFLOW_FILES],
    prPerformedViaAppSlug: APPROVE_TRUSTED_PUBLISHER_APP_SLUG,
    handoffMarkers: [botHandoffMarker()],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ci.yml: main-only push CI plus exact-HEAD checkout
// ---------------------------------------------------------------------------

describe('ticket #82 ci triggers and checkout', () => {
  it('keeps authoritative PR CI and main-only push CI', () => {
    const ci = readWorkflow('ci.yml');

    expect(extractCiPushBranches(ci)).toEqual(['main']);
    expect(hasPullRequestTrigger(ci)).toBe(true);
    expect(ci).not.toMatch(/branches:\s*\['\*\*'\]/);
  });

  it('checks out the exact PR HEAD on pull_request and the event SHA on main push', () => {
    const ci = readWorkflow('ci.yml');
    const ref = extractCiCheckoutRef(ci);

    expect(ref).toBeDefined();
    // Location-specific contract: the live input references the PR head SHA
    // and falls back to the event SHA. A commented-out input cannot satisfy
    // this because full-line comments are excluded from extraction.
    expect(ref ?? '').toContain('github.event.pull_request.head.sha');
    expect(ref ?? '').toContain('github.sha');
    expect(evaluateActionsExpression(ref ?? '', checkoutContext('pull_request'))).toBe(PR_HEAD);
    expect(evaluateActionsExpression(ref ?? '', checkoutContext('push'))).toBe(PUSH_SHA);
  });

  it('fails the checkout contract when the input is commented out or swapped', () => {
    const ci = readWorkflow('ci.yml');
    const ref = extractCiCheckoutRef(ci);
    expect(ref).toBeDefined();

    const commented = ci.replace(
      /with:\s*\n\s*ref:[^\n]*/,
      'with:\n          # ref: ${{ github.event.pull_request.head.sha }}',
    );
    expect(extractCiCheckoutRef(commented)).toBeUndefined();

    const swapped =
      "${{ github.event_name == 'pull_request' && github.sha || github.event.pull_request.head.sha }}";
    expect(evaluateActionsExpression(swapped, checkoutContext('pull_request'))).toBe(MERGE_SHA);
    expect(evaluateActionsExpression(ref ?? '', checkoutContext('pull_request'))).toBe(PR_HEAD);
    expect(evaluateActionsExpression(swapped, checkoutContext('pull_request'))).not.toBe(
      evaluateActionsExpression(ref ?? '', checkoutContext('pull_request')),
    );
  });

  it('rejects a checkout ref moved onto another step', () => {
    // Regression: a regex reader searching later `with` blocks beyond the
    // checkout step preserves the extracted ref when it is moved onto
    // setup-node. The location-specific reader must not.
    const ci = readWorkflow('ci.yml');
    const liveRef = extractCiCheckoutRef(ci);
    expect(liveRef).toBeDefined();

    const doc = parseWorkflowDocument(ci) as {
      jobs: { gates: { steps: Record<string, unknown>[] } };
    };
    const steps = doc.jobs.gates.steps;
    const checkout = steps.find(
      (step) => typeof step.uses === 'string' && step.uses.includes('actions/checkout@'),
    );
    const setupNode = steps.find(
      (step) => typeof step.uses === 'string' && step.uses.includes('actions/setup-node@'),
    );
    expect(checkout).toBeDefined();
    expect(setupNode).toBeDefined();
    if (setupNode === undefined) {
      throw new Error('test setup: setup-node step missing');
    }
    const checkoutWith = checkout?.with as Record<string, unknown> | undefined;
    const movedRef = checkoutWith?.ref;
    if (checkoutWith !== undefined) {
      delete checkoutWith.ref;
    }
    setupNode.with = {
      ...((setupNode.with ?? {}) as Record<string, unknown>),
      ref: movedRef,
    };
    const mutated = stringifyYaml(doc);

    expect(extractCiCheckoutRef(mutated)).toBeUndefined();
    expect(extractCiCheckoutRef(mutated)).not.toBe(liveRef);
  });
});

// ---------------------------------------------------------------------------
// Cheap job-level prefilter with Actions semantics
// ---------------------------------------------------------------------------

describe('ticket #82 cheap job prefilter', () => {
  it('reads the real job conditions from their workflow locations', () => {
    const ticketIf = extractJobIf(readWorkflow('agent-ticket.yml'));
    const fixCycleIf = extractJobIf(readWorkflow('agent-fix-cycle.yml'));

    expect(ticketIf).toBeDefined();
    expect(fixCycleIf).toBeDefined();
    expect(ticketIf ?? '').toContain('/agent-ticket');
    expect(fixCycleIf ?? '').toContain('/agent-fix-cycle');
    expect(ticketIf ?? '').toContain('author_association');
    expect(fixCycleIf ?? '').toContain('author_association');
  });

  it('rejects a job condition moved onto a step', () => {
    // Regression: a regex reader accepting the first indented `if` anywhere
    // after `jobs` preserves the extracted expression when `jobs.run.if`
    // moves onto the checkout step. The location-specific reader must not.
    for (const name of ['agent-ticket.yml', 'agent-fix-cycle.yml'] as const) {
      const text = readWorkflow(name);
      const liveIf = extractJobIf(text);
      expect(liveIf).toBeDefined();

      const doc = parseWorkflowDocument(text) as {
        jobs: { run: { if?: unknown; steps: Record<string, unknown>[] } };
      };
      const job = doc.jobs.run;
      const moved = job.if;
      delete job.if;
      const firstStep = job.steps[0];
      expect(firstStep).toBeDefined();
      if (firstStep !== undefined) {
        firstStep.if = moved;
      }
      const mutated = stringifyYaml(doc);

      expect(extractJobIf(mutated)).toBeUndefined();
      expect(extractJobIf(mutated)).not.toBe(liveIf);
    }
  });

  it('allocates no job for ordinary comments', () => {
    const ticketIf = extractJobIf(readWorkflow('agent-ticket.yml')) ?? '';
    const fixCycleIf = extractJobIf(readWorkflow('agent-fix-cycle.yml')) ?? '';

    expect(
      evaluateJobEligible(
        ticketIf,
        jobContext({ body: 'Looks good, thanks!', association: 'OWNER', isPr: false }),
      ),
    ).toBe(false);
    expect(
      evaluateJobEligible(
        fixCycleIf,
        jobContext({ body: 'Needs a test', association: 'OWNER', isPr: true }),
      ),
    ).toBe(false);
  });

  it('admits exact authorized commands on the correct target kind', () => {
    const ticketIf = extractJobIf(readWorkflow('agent-ticket.yml')) ?? '';
    const fixCycleIf = extractJobIf(readWorkflow('agent-fix-cycle.yml')) ?? '';

    expect(
      evaluateJobEligible(
        ticketIf,
        jobContext({ body: '/agent-ticket', association: 'OWNER', isPr: false }),
      ),
    ).toBe(true);
    expect(
      evaluateJobEligible(
        ticketIf,
        jobContext({ body: '/agent-ticket', association: 'COLLABORATOR', isPr: false }),
      ),
    ).toBe(true);
    expect(
      evaluateJobEligible(
        fixCycleIf,
        jobContext({ body: '/agent-fix-cycle', association: 'MEMBER', isPr: true }),
      ),
    ).toBe(true);
  });

  it('rejects whitespace/extra-text variants and wrong target kinds before any runner', () => {
    const ticketIf = extractJobIf(readWorkflow('agent-ticket.yml')) ?? '';
    const fixCycleIf = extractJobIf(readWorkflow('agent-fix-cycle.yml')) ?? '';

    for (const body of ['  /agent-ticket  ', '/agent-ticket please', '/agent-ticket\nmore']) {
      expect(
        evaluateJobEligible(ticketIf, jobContext({ body, association: 'OWNER', isPr: false })),
      ).toBe(false);
    }
    expect(
      evaluateJobEligible(
        ticketIf,
        jobContext({ body: '/agent-ticket', association: 'OWNER', isPr: true }),
      ),
    ).toBe(false);
    expect(
      evaluateJobEligible(
        fixCycleIf,
        jobContext({ body: '/agent-fix-cycle', association: 'OWNER', isPr: false }),
      ),
    ).toBe(false);
    expect(
      evaluateJobEligible(
        fixCycleIf,
        jobContext({ body: '/agent-ticket', association: 'OWNER', isPr: true }),
      ),
    ).toBe(false);
  });

  it('rejects unauthorized actors before any runner', () => {
    const ticketIf = extractJobIf(readWorkflow('agent-ticket.yml')) ?? '';
    const fixCycleIf = extractJobIf(readWorkflow('agent-fix-cycle.yml')) ?? '';

    for (const association of ['CONTRIBUTOR', 'NONE', 'FIRST_TIMER']) {
      expect(
        evaluateJobEligible(
          ticketIf,
          jobContext({ body: '/agent-ticket', association, isPr: false }),
        ),
      ).toBe(false);
      expect(
        evaluateJobEligible(
          fixCycleIf,
          jobContext({ body: '/agent-fix-cycle', association, isPr: true }),
        ),
      ).toBe(false);
    }
  });

  it('documents the accepted two-stage case policy honestly', () => {
    // GitHub Actions string equality ignores case, so the cheap prefilter may
    // admit uppercase variants to a runner. The downstream TypeScript guard
    // keeps exact lowercase validation and rejects them before any work.
    const ticketIf = extractJobIf(readWorkflow('agent-ticket.yml')) ?? '';
    const fixCycleIf = extractJobIf(readWorkflow('agent-fix-cycle.yml')) ?? '';

    expect(
      evaluateJobEligible(
        ticketIf,
        jobContext({ body: '/AGENT-TICKET', association: 'OWNER', isPr: false }),
      ),
    ).toBe(true);
    expect(
      evaluateJobEligible(
        fixCycleIf,
        jobContext({ body: '/Agent-Fix-Cycle', association: 'OWNER', isPr: true }),
      ),
    ).toBe(true);
    expect(parseAgentCommand('/AGENT-TICKET')).toBeUndefined();
    expect(parseAgentCommand('/Agent-Fix-Cycle')).toBeUndefined();
    expect(parseAgentCommand('/agent-ticket')).toBe('agent-ticket');
    expect(parseAgentCommand('/agent-fix-cycle')).toBe('agent-fix-cycle');
    expect(isAuthorizedAssociation('OWNER')).toBe(true);
    expect(isAuthorizedAssociation('owner')).toBe(false);
  });

  it('evaluates boolean literals per Actions semantics', () => {
    expect(evaluateActionsExpression('${{ true }}', {})).toBe(true);
    expect(evaluateActionsExpression('${{ false }}', {})).toBe(false);
    expect(evaluateActionsExpression('true', {})).toBe(true);
  });

  it('fails closed on unsupported syntax instead of guessing', () => {
    expect(() => evaluateActionsExpression('${{ foo(1) }}', { foo: 1 })).toThrow(/support/);
    expect(() => evaluateActionsExpression('${{ github.sha > 1 }}', { github: {} })).toThrow(
      /support/,
    );
    expect(() => evaluateActionsExpression('${{ unknown.root }}', { github: {} })).toThrow(
      /support/,
    );
  });

  it('detects unconditional or weakened eligibility through the same evaluator', () => {
    const ticketIf = extractJobIf(readWorkflow('agent-ticket.yml')) ?? '';
    const fixCycleIf = extractJobIf(readWorkflow('agent-fix-cycle.yml')) ?? '';
    const ordinaryTicket = jobContext({
      body: 'ordinary comment',
      association: 'CONTRIBUTOR',
      isPr: false,
    });
    const ordinaryFixCycle = jobContext({
      body: 'ordinary comment',
      association: 'CONTRIBUTOR',
      isPr: true,
    });

    // A replaced `if: true` would allocate a runner for ordinary comments.
    expect(evaluateJobEligible('true', ordinaryTicket)).toBe(true);
    expect(evaluateJobEligible(ticketIf, ordinaryTicket)).toBe(false);

    // Appending `|| true` has the same effect through real evaluation, not
    // text recognition.
    expect(evaluateJobEligible(`${unwrapExpression(ticketIf)} || true`, ordinaryTicket)).toBe(true);
    expect(evaluateJobEligible(`${unwrapExpression(fixCycleIf)} || true`, ordinaryFixCycle)).toBe(
      true,
    );

    // Dropping the authorization clause admits unauthorized actors.
    const ticketWithoutAuth =
      "!github.event.issue.pull_request && github.event.comment.body == '/agent-ticket'";
    expect(
      evaluateJobEligible(
        ticketWithoutAuth,
        jobContext({ body: '/agent-ticket', association: 'NONE', isPr: false }),
      ),
    ).toBe(true);
    expect(
      evaluateJobEligible(
        ticketIf,
        jobContext({ body: '/agent-ticket', association: 'NONE', isPr: false }),
      ),
    ).toBe(false);

    // A commented-out condition contributing only comment text cannot satisfy
    // the contract: extraction ignores full-line comments.
    const commented = `    # if: \${{ ${ticketIf} }}\n    if: true`;
    expect(extractJobIf(`jobs:\n  run:\n${commented}\n    runs-on: ubuntu-latest`)).toBe('true');
  });
});

// ---------------------------------------------------------------------------
// Trusted-handoff marker unit contracts
// ---------------------------------------------------------------------------

describe('ticket #82 trusted handoff marker', () => {
  it('round-trips deterministically and stays non-secret', () => {
    const raw = formatTrustedHandoffMarker({
      ticket: TICKET,
      branch: BRANCH,
      base: BASE_SHA,
      head: HANDOFF_HEAD,
      files: [...WORKFLOW_FILES].reverse(),
    });

    expect(raw).toContain('trusted-workflow-handoff:v1');
    expect(raw).toContain(String(TICKET));
    expect(raw).toContain(BRANCH);
    const parsed = parseTrustedHandoffMarker(`Human BLOCKED message\n\n${raw}`);
    expect(parsed).toMatchObject({ ticket: TICKET, branch: BRANCH });
    expect(parsed?.files).toEqual([...WORKFLOW_FILES].sort());
  });

  it('rejects malformed or non-workflow markers', () => {
    expect(parseTrustedHandoffMarker('no marker here')).toBeNull();
    expect(parseTrustedHandoffMarker('<!-- trusted-workflow-handoff:v1 {oops} -->')).toBeNull();
    expect(
      parseTrustedHandoffMarker(
        formatTrustedHandoffMarker({
          ticket: TICKET,
          branch: BRANCH,
          base: BASE_SHA,
          head: HANDOFF_HEAD,
          files: ['src/not-a-workflow.ts'],
        }),
      ),
    ).toBeNull();
  });

  it('requires full workflow-file coverage and refuses empty sets', () => {
    const marker = botHandoffMarker();

    expect(isHandoffCovering(marker, WORKFLOW_FILES)).toBe(true);
    expect(isHandoffCovering(marker, [WORKFLOW_FILES[0] ?? ''])).toBe(true);
    expect(isHandoffCovering(marker, [])).toBe(false);
    expect(isHandoffCovering(marker, [...WORKFLOW_FILES, '.github/workflows/extra.yml'])).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Approver decisions: bot path plus handoff path
// ---------------------------------------------------------------------------

describe('ticket #82 approver decisions', () => {
  it('keeps the normal bot path trusted', () => {
    const decision = decideAgentCiApproval({
      ...handoffProvenance(),
      prAuthorLogin: APPROVE_BOT_LOGIN,
      prPerformedViaAppSlug: undefined,
      handoffMarkers: undefined,
      changedFiles: ['src/features/identity/route.ts'],
    });

    expect(decision.approved).toBe(true);
  });

  it('trusts a connector-published handoff with a matching bot marker', () => {
    const decision = decideAgentCiApproval(handoffProvenance());

    expect(decision.approved).toBe(true);
    if (decision.approved) {
      expect(decision.ticket).toBe(TICKET);
    }
  });

  it('refuses a connector handoff with only non-workflow changes', () => {
    const decision = decideAgentCiApproval(
      handoffProvenance({ changedFiles: ['src/features/identity/route.ts'] }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/workflow|handoff|bot/i);
  });

  it('refuses owner-authored manual PRs and marker-less connector PRs', () => {
    const manual = decideAgentCiApproval(
      handoffProvenance({
        changedFiles: ['src/x.ts'],
        prPerformedViaAppSlug: '',
        handoffMarkers: [],
      }),
    );
    const noMarker = decideAgentCiApproval(
      handoffProvenance({
        prPerformedViaAppSlug: APPROVE_TRUSTED_PUBLISHER_APP_SLUG,
        handoffMarkers: [],
      }),
    );

    expect(manual.approved).toBe(false);
    expect(noMarker.approved).toBe(false);
    expect(noMarker.reason).toMatch(/marker|handoff/i);
  });

  it('refuses wrong app, branch, ticket, stale HEAD, fork, base, and partial coverage', () => {
    expect(
      decideAgentCiApproval(handoffProvenance({ prPerformedViaAppSlug: 'other-app' })).approved,
    ).toBe(false);
    expect(
      decideAgentCiApproval(
        handoffProvenance({
          handoffMarkers: [{ ...botHandoffMarker(), branch: 'ticket/82-other-slug' }],
        }),
      ).approved,
    ).toBe(false);
    expect(
      decideAgentCiApproval(
        handoffProvenance({ handoffMarkers: [{ ...botHandoffMarker(), ticket: 81 }] }),
      ).approved,
    ).toBe(false);
    expect(decideAgentCiApproval(handoffProvenance({ runHeadSha: HANDOFF_HEAD })).approved).toBe(
      false,
    );
    expect(
      decideAgentCiApproval(handoffProvenance({ prHeadRepo: 'attacker/user-service-platform' }))
        .approved,
    ).toBe(false);
    expect(decideAgentCiApproval(handoffProvenance({ prBaseRef: 'develop' })).approved).toBe(false);
    expect(
      decideAgentCiApproval(
        handoffProvenance({ changedFiles: [...WORKFLOW_FILES, '.github/workflows/extra.yml'] }),
      ).approved,
    ).toBe(false);
  });

  it('keeps corrected HEADs on trusted handoffs exact-HEAD gated', () => {
    // Trust attaches to publication provenance + marker; the marker head is
    // the original implementation HEAD, while approval still requires the run
    // HEAD to equal the current PR HEAD.
    const correctedHead = 'b'.repeat(40);
    const approved = decideAgentCiApproval(
      handoffProvenance({ prHeadSha: correctedHead, runHeadSha: correctedHead }),
    );
    const stale = decideAgentCiApproval(
      handoffProvenance({ prHeadSha: correctedHead, runHeadSha: HANDOFF_HEAD }),
    );

    expect(approved.approved).toBe(true);
    expect(stale.approved).toBe(false);
    expect(stale.reason).toMatch(/HEAD/i);
  });
});

// ---------------------------------------------------------------------------
// Approver evaluation with distinct source-ticket and PR provenance
// ---------------------------------------------------------------------------

describe('ticket #82 provenance evaluation from GitHub-owned reads', () => {
  function prPayload(author: string): string {
    return JSON.stringify({
      state: 'open',
      title: PR_TITLE,
      body: PR_BODY,
      user: { login: author },
      base: { ref: 'main', repo: { full_name: REPO } },
      head: { ref: BRANCH, sha: PR_HEAD, repo: { full_name: REPO } },
    });
  }

  function ticketPayload(): string {
    return JSON.stringify({
      number: TICKET,
      state: 'open',
      labels: [{ name: 'ready-for-agent' }],
    });
  }

  function filesPayload(): string {
    return `${WORKFLOW_FILES.join('\n')}\n`;
  }

  function commentsPayload(markerBody: string): string {
    // Emulates `gh api .../comments --paginate --jq '.[] | {...} | @json'`
    // in raw-output mode: one compact JSON object per comment per line.
    // Pages concatenate safely, so a marker on a later page is preserved.
    const lines = [
      JSON.stringify({ body: 'ordinary status comment', user: { login: 'JonatanGarbuyo' } }),
      JSON.stringify({ body: markerBody, user: { login: APPROVE_BOT_LOGIN } }),
    ];
    return `${lines.join('\n')}\n`;
  }

  function commentsTwoPagePayload(markerBody: string): string {
    // Multi-page fixture: page one carries only ordinary comments, page two
    // carries the valid bot marker. Distinct source ticket #82 / PR #109
    // provenance is asserted by the caller through TICKET/PR_NUMBER.
    const pageOne = [
      JSON.stringify({ body: 'status: running gates', user: { login: 'JonatanGarbuyo' } }),
      JSON.stringify({ body: 'status: review cycle', user: { login: APPROVE_BOT_LOGIN } }),
    ];
    const pageTwo = [
      JSON.stringify({ body: 'ordinary follow-up', user: { login: 'JonatanGarbuyo' } }),
      JSON.stringify({ body: markerBody, user: { login: APPROVE_BOT_LOGIN } }),
    ];
    return `${[...pageOne, ...pageTwo].join('\n')}\n`;
  }

  function handoffExecutor(options: {
    prIssueAppSlug: string;
    ticketIssueAppSlug?: string;
    markerBody?: string;
    commentsStdout?: string;
    seen: string[];
  }): CommandExecutor {
    const marker =
      options.markerBody ??
      `BLOCKED trusted-publication-required\n\n${formatTrustedHandoffMarker({
        ticket: TICKET,
        branch: BRANCH,
        base: BASE_SHA,
        head: HANDOFF_HEAD,
        files: WORKFLOW_FILES,
      })}`;
    return (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      options.seen.push(key);
      if (key === `gh api repos/${REPO}/pulls/${String(PR_NUMBER)}`) {
        return Promise.resolve({ stdout: `${prPayload('JonatanGarbuyo')}\n`, stderr: '' });
      }
      if (key === `gh api repos/${REPO}/issues/${String(TICKET)}`) {
        const extra =
          options.ticketIssueAppSlug === undefined
            ? {}
            : { performed_via_github_app: { slug: options.ticketIssueAppSlug } };
        return Promise.resolve({
          stdout: `${JSON.stringify({ ...JSON.parse(ticketPayload()), ...extra })}\n`,
          stderr: '',
        });
      }
      if (key.startsWith(`gh api repos/${REPO}/pulls/${String(PR_NUMBER)}/files`)) {
        return Promise.resolve({ stdout: filesPayload(), stderr: '' });
      }
      if (key === `gh api repos/${REPO}/issues/${String(PR_NUMBER)}`) {
        const payload =
          options.prIssueAppSlug === ''
            ? { number: PR_NUMBER }
            : {
                number: PR_NUMBER,
                performed_via_github_app: { slug: options.prIssueAppSlug },
              };
        return Promise.resolve({ stdout: `${JSON.stringify(payload)}\n`, stderr: '' });
      }
      if (key.startsWith(`gh api repos/${REPO}/issues/${String(TICKET)}/comments`)) {
        const stdout = options.commentsStdout ?? `${commentsPayload(marker)}\n`;
        return Promise.resolve({ stdout, stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
  }

  function baseInput(prNumbers: readonly number[] = [PR_NUMBER]) {
    return {
      repoSlug: REPO,
      runId: 35765615075,
      workflowName: 'ci',
      runConclusion: 'action_required' as const,
      runHeadSha: PR_HEAD,
      pullRequestNumbers: prNumbers,
    };
  }

  it('approves a handoff only from the PR issue app slug and ticket marker', async () => {
    const seen: string[] = [];
    const decision = await evaluateAgentCiApproval(
      handoffExecutor({ prIssueAppSlug: APPROVE_TRUSTED_PUBLISHER_APP_SLUG, seen }),
      baseInput(),
    );

    expect(decision.approved).toBe(true);
    // Provenance separation: publisher provenance comes from issues/{pr},
    // handoff comments come from issues/{ticket}/comments.
    expect(seen).toContain(`gh api repos/${REPO}/issues/${String(PR_NUMBER)}`);
    expect(
      seen.some((key) => key.startsWith(`gh api repos/${REPO}/issues/${String(TICKET)}/comments`)),
    ).toBe(true);
  });

  it('refuses when publisher provenance is queried with the ticket number', async () => {
    // The ticket carries the trusted app slug but the PR issue does not. An
    // implementation reading provenance from the ticket number would approve;
    // the correct implementation reads issues/{pr} and refuses.
    const seen: string[] = [];
    const decision = await evaluateAgentCiApproval(
      handoffExecutor({
        prIssueAppSlug: '',
        ticketIssueAppSlug: APPROVE_TRUSTED_PUBLISHER_APP_SLUG,
        seen,
      }),
      baseInput(),
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/publisher/i);
  });

  it('refuses wrong or missing PR app provenance even with a valid marker', async () => {
    for (const slug of ['', 'other-app']) {
      const decision = await evaluateAgentCiApproval(
        handoffExecutor({ prIssueAppSlug: slug, seen: [] }),
        baseInput(),
      );

      expect(decision.approved).toBe(false);
      expect(decision.reason).toMatch(/publisher/i);
    }
  });

  it('approves when the valid bot marker arrives on page two', async () => {
    // Multi-page integration: the source ticket is #82, the PR is #109, and
    // only the second page carries the trusted bot marker. The agreed
    // `--paginate --jq` contract concatenates per-comment lines, so the
    // marker must survive pagination.
    const markerBody = `BLOCKED trusted-publication-required\n\n${formatTrustedHandoffMarker({
      ticket: TICKET,
      branch: BRANCH,
      base: BASE_SHA,
      head: HANDOFF_HEAD,
      files: WORKFLOW_FILES,
    })}`;
    const decision = await evaluateAgentCiApproval(
      handoffExecutor({
        prIssueAppSlug: APPROVE_TRUSTED_PUBLISHER_APP_SLUG,
        commentsStdout: commentsTwoPagePayload(markerBody),
        seen: [],
      }),
      baseInput(),
    );

    expect(decision.approved).toBe(true);
    if (decision.approved) {
      expect(decision.ticket).toBe(TICKET);
    }
  });

  it('still refuses untrusted authors and missing markers across pages', async () => {
    const markerBody = `BLOCKED trusted-publication-required\n\n${formatTrustedHandoffMarker({
      ticket: TICKET,
      branch: BRANCH,
      base: BASE_SHA,
      head: HANDOFF_HEAD,
      files: WORKFLOW_FILES,
    })}`;
    const untrustedPageTwo = [
      JSON.stringify({ body: 'status: running', user: { login: 'JonatanGarbuyo' } }),
      JSON.stringify({ body: markerBody, user: { login: 'JonatanGarbuyo' } }),
    ].join('\n');
    const missingMarker = [
      JSON.stringify({ body: 'status: running', user: { login: 'JonatanGarbuyo' } }),
      JSON.stringify({ body: 'no marker here', user: { login: APPROVE_BOT_LOGIN } }),
    ].join('\n');

    for (const commentsStdout of [untrustedPageTwo, missingMarker, '']) {
      const decision = await evaluateAgentCiApproval(
        handoffExecutor({
          prIssueAppSlug: APPROVE_TRUSTED_PUBLISHER_APP_SLUG,
          commentsStdout,
          seen: [],
        }),
        baseInput(),
      );
      expect(decision.approved).toBe(false);
    }
  });

  it('agrees on the paginated comment CLI output contract', () => {
    // Producer must iterate page arrays element-wise so `--paginate` pages
    // concatenate safely. Omitting `.[]` fails even for a single API array.
    const args = buildTicketCommentsArgs(REPO, TICKET);
    const jq = args[args.indexOf('--jq') + 1] ?? '';
    expect(args).toContain('--paginate');
    expect(args).toContain('--jq');
    expect(jq).toContain('.[]');
    expect(jq).toContain('body');
    expect(jq).toContain('user');

    const markerBody = `BLOCKED marker\n\n${formatTrustedHandoffMarker({
      ticket: TICKET,
      branch: BRANCH,
      base: BASE_SHA,
      head: HANDOFF_HEAD,
      files: WORKFLOW_FILES,
    })}`;
    const comment = (body: string, login: string): string =>
      JSON.stringify({ body, user: { login } });
    // Two compact single-line page arrays concatenate into two lines. The
    // consumer must flatten each page so the page-two bot marker survives
    // instead of degrading to empty body/author records.
    const pageOne = JSON.stringify([JSON.parse(comment('ordinary one', 'JonatanGarbuyo'))]);
    const pageTwo = JSON.stringify([
      JSON.parse(comment('ordinary two', 'JonatanGarbuyo')),
      JSON.parse(comment(markerBody, APPROVE_BOT_LOGIN)),
    ]);
    const paged = parseTicketCommentsOutput(`${pageOne}\n${pageTwo}\n`);
    expect(paged.map((entry) => entry.body)).toContain(markerBody);
    expect(collectBotHandoffMarkers(paged).length).toBe(1);

    // `@json` double-encoded lines (one JSON string per comment) unwrap too.
    const encoded = [
      comment('ordinary one', 'JonatanGarbuyo'),
      comment(markerBody, APPROVE_BOT_LOGIN),
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const decoded = parseTicketCommentsOutput(`${encoded}\n`);
    expect(decoded.map((entry) => entry.body)).toContain(markerBody);
    expect(collectBotHandoffMarkers(decoded).length).toBe(1);
  });

  it('parses PR issue slugs and ticket comments fail-closed', () => {
    expect(
      parsePrIssueAppSlug(
        JSON.stringify({ performed_via_github_app: { slug: 'chatgpt-codex-connector' } }),
      ),
    ).toBe('chatgpt-codex-connector');
    expect(parsePrIssueAppSlug('{}')).toBe('');
    expect(parsePrIssueAppSlug('not json')).toBe('');
    expect(parseTicketCommentsOutput('')).toEqual([]);
    expect(collectBotHandoffMarkers(parseTicketCommentsOutput(JSON.stringify([]))).length).toBe(0);
  });

  it('names the correct provenance variables', () => {
    expect(buildPrIssueFetchArgs(REPO, PR_NUMBER)).toEqual([
      'api',
      `repos/${REPO}/issues/${String(PR_NUMBER)}`,
    ]);
    expect(buildPrIssueFetchArgs(REPO, PR_NUMBER)).not.toEqual([
      'api',
      `repos/${REPO}/issues/${String(TICKET)}`,
    ]);
    const commentArgs = buildTicketCommentsArgs(REPO, TICKET);
    expect(commentArgs.slice(0, 3)).toEqual([
      'api',
      `repos/${REPO}/issues/${String(TICKET)}/comments`,
      '--paginate',
    ]);
    expect(commentArgs).toContain('--jq');
    const jq = commentArgs[commentArgs.indexOf('--jq') + 1] ?? '';
    expect(jq).toContain('.[]');
  });
});

// ---------------------------------------------------------------------------
// Scheduled backstop stays inside the bounded review wait
// ---------------------------------------------------------------------------

describe('ticket #82 approval backstop bound', () => {
  it('keeps a low-frequency scheduled backstop with dispatch liveness', () => {
    const approver = readWorkflow('approve-agent-ci.yml');
    const cron = extractScheduleCron(approver);

    expect(cron).toBeDefined();
    expect(cronIntervalMinutes(cron ?? '')).toBe(10);
    expect(approver).toMatch(/repository_dispatch/);
    expect(approver).toMatch(/approve-agent-ci-request/);
    expect(approver).toMatch(/schedule/);
  });

  it('bounds the review wait beyond the worst-case backstop tick plus margin', () => {
    const approver = readWorkflow('approve-agent-ci.yml');
    const interval = cronIntervalMinutes(extractScheduleCron(approver) ?? '');
    const waitMs = CHECK_POLL_ATTEMPTS * CHECK_POLL_DELAY_MS;

    expect(interval).toBe(10);
    expect(CHECK_POLL_DELAY_MS).toBe(10000);
    // 12-minute wait strictly exceeds the 10-minute tick plus queue/startup
    // margin, so the scheduled path remains an in-cycle recovery backstop.
    expect(interval ?? 0).toBe(10);
    expect(waitMs).toBeGreaterThan((interval ?? 0) * 60 * 1000 + 60 * 1000);
  });
});
