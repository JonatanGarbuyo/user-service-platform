import type { CommandExecutor } from './runner.js';
import { isWorkflowFile } from './workflow-handoff.js';

// Deterministic provenance guards for auto-approving exact-HEAD CI on trusted
// agent-created PRs (ticket #44). The separate trusted approver workflow is
// driven by `workflow_run` for the `ci` workflow and approves only runs that
// prove every guard below from GitHub-owned metadata. It never checks out or
// executes PR code, and workflow-file PR changes stay governed by the #36
// trusted-publication policy. All refusals fail closed with concise evidence.
export const APPROVE_TRUSTED_WORKFLOW_NAME = 'ci';
export const APPROVE_REQUIRED_CONCLUSION = 'action_required';
export const APPROVE_BOT_LOGIN = 'github-actions[bot]';
export const APPROVE_READY_LABEL = 'ready-for-agent';

const TICKET_BRANCH_PATTERN = /^ticket\/([1-9]\d*)-[^/]+$/;
const EXACT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

export function parseTicketBranch(branch: string | undefined | null): number | null {
  if (typeof branch !== 'string') {
    return null;
  }
  const match = TICKET_BRANCH_PATTERN.exec(branch.trim());
  const ticketText = match?.[1];
  if (ticketText === undefined) {
    return null;
  }
  const ticket = Number.parseInt(ticketText, 10);
  if (!Number.isInteger(ticket) || ticket <= 0) {
    return null;
  }
  return ticket;
}

export function prTitleIdentifiesTicket(title: string | undefined | null, ticket: number): boolean {
  if (typeof title !== 'string') {
    return false;
  }
  return title.endsWith(` (#${String(ticket)})`);
}

export function prBodyIdentifiesTicket(body: string | undefined | null, ticket: number): boolean {
  if (typeof body !== 'string') {
    return false;
  }
  return body.includes(`Automated implementation of #${String(ticket)}`);
}

export function prIdentifiesTicket(
  title: string | undefined | null,
  body: string | undefined | null,
  ticket: number,
): boolean {
  return prTitleIdentifiesTicket(title, ticket) && prBodyIdentifiesTicket(body, ticket);
}

export interface AgentCiProvenance {
  workflowName: string;
  runConclusion: string | null;
  associatedPrCount: number;
  prNumber: number;
  prState: string;
  prBaseRef: string;
  prHeadRef: string;
  prHeadSha: string;
  prAuthorLogin: string;
  prHeadRepo: string;
  prBaseRepo: string;
  prTitle: string;
  prBody: string;
  runHeadSha: string;
  issueNumber: number;
  issueState: string;
  issueLabels: readonly string[];
  issueIsPullRequest: boolean;
  changedFiles: readonly string[];
}

export type AgentCiDecision =
  | { approved: true; ticket: number; reason: string }
  | { approved: false; ticket?: number; reason: string };

function isExactSha(sha: string | undefined | null): boolean {
  return typeof sha === 'string' && EXACT_SHA_PATTERN.test(sha.trim());
}

export function decideAgentCiApproval(provenance: AgentCiProvenance): AgentCiDecision {
  if (provenance.workflowName !== APPROVE_TRUSTED_WORKFLOW_NAME) {
    return {
      approved: false,
      reason: `refusing: triggering workflow is ${provenance.workflowName || '(missing)'}, expected ${APPROVE_TRUSTED_WORKFLOW_NAME}`,
    };
  }
  if (provenance.runConclusion !== APPROVE_REQUIRED_CONCLUSION) {
    return {
      approved: false,
      reason: `refusing: run conclusion is ${provenance.runConclusion ?? '(missing)'}, expected ${APPROVE_REQUIRED_CONCLUSION}`,
    };
  }
  if (provenance.associatedPrCount !== 1) {
    return {
      approved: false,
      reason: `refusing: expected exactly one associated PR, got ${String(provenance.associatedPrCount)}`,
    };
  }
  if (provenance.prState.toLowerCase() !== 'open') {
    return {
      approved: false,
      reason: `refusing: PR #${String(provenance.prNumber)} state is ${provenance.prState || '(missing)'}, expected OPEN`,
    };
  }
  if (provenance.prBaseRef !== 'main') {
    return {
      approved: false,
      reason: `refusing: PR #${String(provenance.prNumber)} base must be main, got ${provenance.prBaseRef || '(missing)'}`,
    };
  }
  if (provenance.prHeadRepo !== provenance.prBaseRepo) {
    return {
      approved: false,
      reason: `refusing: PR #${String(provenance.prNumber)} is not same-repository (head ${provenance.prHeadRepo || '(missing)'} vs base ${provenance.prBaseRepo || '(missing)'}); fork PRs are not supported`,
    };
  }
  if (provenance.prAuthorLogin !== APPROVE_BOT_LOGIN) {
    return {
      approved: false,
      reason: `refusing: PR #${String(provenance.prNumber)} author is ${provenance.prAuthorLogin || '(missing)'}, expected ${APPROVE_BOT_LOGIN}`,
    };
  }
  const ticket = parseTicketBranch(provenance.prHeadRef);
  if (ticket === null) {
    return {
      approved: false,
      reason: `refusing: PR head branch ${provenance.prHeadRef || '(missing)'} does not match the ticket/<number>-... convention`,
    };
  }
  if (provenance.issueIsPullRequest) {
    return {
      approved: false,
      ticket,
      reason: `refusing: corresponding #${String(provenance.issueNumber)} is a pull request, expected an issue`,
    };
  }
  if (provenance.issueNumber !== ticket) {
    return {
      approved: false,
      ticket,
      reason: `refusing: corresponding issue #${String(provenance.issueNumber)} does not match the branch ticket #${String(ticket)}; PR must identify the same ticket`,
    };
  }
  if (provenance.issueState.toLowerCase() !== 'open') {
    return {
      approved: false,
      ticket,
      reason: `refusing: issue #${String(provenance.issueNumber)} state is ${provenance.issueState || '(missing)'}, expected OPEN`,
    };
  }
  if (!provenance.issueLabels.includes(APPROVE_READY_LABEL)) {
    return {
      approved: false,
      ticket,
      reason: `refusing: issue #${String(provenance.issueNumber)} lacks the ${APPROVE_READY_LABEL} label`,
    };
  }
  if (!prIdentifiesTicket(provenance.prTitle, provenance.prBody, ticket)) {
    return {
      approved: false,
      ticket,
      reason: `refusing: PR title/body do not identify it as the automated implementation of #${String(ticket)}`,
    };
  }
  const workflowFiles = provenance.changedFiles.filter((file) => isWorkflowFile(file));
  if (workflowFiles.length > 0) {
    return {
      approved: false,
      ticket,
      reason: `refusing: PR touches workflow files (${workflowFiles.join(', ')}); workflow-file corrections remain governed by trusted publication and must not be auto-approved`,
    };
  }
  if (!isExactSha(provenance.runHeadSha) || !isExactSha(provenance.prHeadSha)) {
    return {
      approved: false,
      ticket,
      reason:
        'refusing: run HEAD or PR HEAD SHA is missing or ambiguous; cannot prove exact-HEAD equality',
    };
  }
  if (provenance.runHeadSha.toLowerCase() !== provenance.prHeadSha.toLowerCase()) {
    return {
      approved: false,
      ticket,
      reason: `refusing: run HEAD ${provenance.runHeadSha} does not equal PR HEAD ${provenance.prHeadSha}`,
    };
  }
  return {
    approved: true,
    ticket,
    reason: `approved: trusted agent PR #${String(provenance.prNumber)} for issue #${String(ticket)} at exact HEAD ${provenance.prHeadSha}`,
  };
}

export function buildApproveRunArgs(repoSlug: string, runId: number): readonly string[] {
  return ['api', `repos/${repoSlug}/actions/runs/${String(runId)}/approve`, '--method', 'POST'];
}

export function buildPrFetchArgs(repoSlug: string, prNumber: number): readonly string[] {
  return ['api', `repos/${repoSlug}/pulls/${String(prNumber)}`];
}

export function buildIssueFetchArgs(repoSlug: string, issueNumber: number): readonly string[] {
  return ['api', `repos/${repoSlug}/issues/${String(issueNumber)}`];
}

export function buildPrFilesArgs(repoSlug: string, prNumber: number): readonly string[] {
  return [
    'api',
    `repos/${repoSlug}/pulls/${String(prNumber)}/files`,
    '--paginate',
    '--jq',
    '.[].filename',
  ];
}

interface RestPullRequest {
  state?: unknown;
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown };
  base?: { ref?: unknown; repo?: { full_name?: unknown } };
  head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
}

interface RestIssue {
  state?: unknown;
  labels?: unknown;
  number?: unknown;
}

function parsePrResponse(stdout: string): RestPullRequest {
  return JSON.parse(stdout) as RestPullRequest;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseIssueLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      labels.push(entry);
    } else if (
      typeof entry === 'object' &&
      entry !== null &&
      'name' in entry &&
      typeof (entry as { name?: unknown }).name === 'string'
    ) {
      labels.push((entry as { name: string }).name);
    }
  }
  return labels;
}

function parseFilenamesOutput(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      files.push(trimmed);
    }
  }
  return files;
}

export interface WorkflowRunApprovalInput {
  repoSlug: string;
  runId: number;
  workflowName: string;
  runConclusion: string | null;
  runHeadSha: string;
  pullRequestNumbers: readonly number[];
}

// Repository-owned evaluation for the trusted approver workflow: every guard
// is proven from GitHub-owned API reads through the injected executor. Any
// fetch or parse failure refuses closed with evidence instead of guessing.
export async function evaluateAgentCiApproval(
  execute: CommandExecutor,
  input: WorkflowRunApprovalInput,
): Promise<AgentCiDecision> {
  if (input.workflowName !== APPROVE_TRUSTED_WORKFLOW_NAME) {
    return {
      approved: false,
      reason: `refusing: triggering workflow is ${input.workflowName || '(missing)'}, expected ${APPROVE_TRUSTED_WORKFLOW_NAME}`,
    };
  }
  if (input.runConclusion !== APPROVE_REQUIRED_CONCLUSION) {
    return {
      approved: false,
      reason: `refusing: run conclusion is ${input.runConclusion ?? '(missing)'}, expected ${APPROVE_REQUIRED_CONCLUSION}`,
    };
  }
  if (input.pullRequestNumbers.length !== 1 || input.pullRequestNumbers[0] === undefined) {
    return {
      approved: false,
      reason: `refusing: expected exactly one associated PR, got ${String(input.pullRequestNumbers.length)}`,
    };
  }
  const prNumber = input.pullRequestNumbers[0];

  let pr: RestPullRequest;
  try {
    const { stdout } = await execute('gh', buildPrFetchArgs(input.repoSlug, prNumber));
    pr = parsePrResponse(stdout);
  } catch (error) {
    return {
      approved: false,
      reason: `refusing: cannot prove PR provenance: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const prHeadRef = stringField(pr.head?.ref);
  const ticket = parseTicketBranch(prHeadRef);
  if (ticket === null) {
    return {
      approved: false,
      reason: `refusing: PR head branch ${prHeadRef || '(missing)'} does not match the ticket/<number>-... convention`,
    };
  }

  let issue: RestIssue;
  let issueIsPullRequest: boolean;
  try {
    const { stdout } = await execute('gh', buildIssueFetchArgs(input.repoSlug, ticket));
    const parsed = JSON.parse(stdout) as RestIssue & { pull_request?: unknown };
    issue = parsed;
    issueIsPullRequest = parsed.pull_request !== undefined;
  } catch (error) {
    return {
      approved: false,
      ticket,
      reason: `refusing: cannot prove issue provenance: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let changedFiles: string[];
  try {
    const { stdout } = await execute('gh', buildPrFilesArgs(input.repoSlug, prNumber));
    changedFiles = parseFilenamesOutput(stdout);
  } catch (error) {
    return {
      approved: false,
      ticket,
      reason: `refusing: cannot prove the PR is free of workflow files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return decideAgentCiApproval({
    workflowName: input.workflowName,
    runConclusion: input.runConclusion,
    associatedPrCount: input.pullRequestNumbers.length,
    prNumber,
    prState: stringField(pr.state),
    prBaseRef: stringField(pr.base?.ref),
    prHeadRef,
    prHeadSha: stringField(pr.head?.sha),
    prAuthorLogin: typeof pr.user?.login === 'string' ? pr.user.login : '',
    prHeadRepo: stringField(pr.head?.repo?.full_name),
    prBaseRepo: stringField(pr.base?.repo?.full_name),
    prTitle: stringField(pr.title),
    prBody: pr.body === null || pr.body === undefined ? '' : stringField(pr.body),
    runHeadSha: input.runHeadSha,
    issueNumber: typeof issue.number === 'number' ? issue.number : ticket,
    issueState: stringField(issue.state),
    issueLabels: parseIssueLabels(issue.labels),
    issueIsPullRequest,
    changedFiles,
  });
}

export async function approveWorkflowRun(
  execute: CommandExecutor,
  repoSlug: string,
  runId: number,
): Promise<void> {
  await execute('gh', buildApproveRunArgs(repoSlug, runId));
}
