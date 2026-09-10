import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout, stderr: stderr };
}

export async function getCurrentHead(): Promise<string> {
  const { stdout } = await runCommand('git', ['rev-parse', 'HEAD']);
  return stdout.trim();
}

export async function getCurrentBranch(): Promise<string> {
  const { stdout } = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

export async function isWorktreeClean(): Promise<boolean> {
  const { stdout } = await runCommand('git', ['status', '--porcelain']);
  return stdout.trim() === '';
}

export interface PrInfo {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
}

interface GhPrView {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
}

export async function getPrForBranch(prArg?: string): Promise<PrInfo> {
  const args =
    prArg !== undefined
      ? ['pr', 'view', prArg, '--json', 'number,headRefName,baseRefName,headRefOid']
      : ['pr', 'view', '--json', 'number,headRefName,baseRefName,headRefOid'];
  const { stdout } = await runCommand('gh', args);
  const parsed = JSON.parse(stdout) as GhPrView;
  return {
    number: parsed.number,
    headRefName: parsed.headRefName,
    baseRefName: parsed.baseRefName,
    headRefOid: parsed.headRefOid,
  };
}

export interface PrComment {
  body: string;
  createdAt: string;
}

export async function listPrComments(prNumber: number): Promise<PrComment[]> {
  const { stdout } = await runCommand('gh', [
    'pr',
    'view',
    String(prNumber),
    '--json',
    'comments',
    '--jq',
    '.comments[] | {body: .body, createdAt: .createdAt}',
  ]);
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  const lines = trimmed.split('\n');
  const comments: PrComment[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = JSON.parse(line) as { body?: unknown; createdAt?: unknown };
    if (typeof parsed.body === 'string' && typeof parsed.createdAt === 'string') {
      comments.push({ body: parsed.body, createdAt: parsed.createdAt });
    }
  }
  return comments;
}

export type ReviewAxisName = 'review-standards' | 'review-spec';
export type ReviewAgentName = 'reviewer-standards' | 'reviewer-spec';

export async function runReviewAxis(
  command: ReviewAxisName,
  agent: ReviewAgentName,
  prNumber: number,
  extraArgs: readonly string[] = [],
): Promise<void> {
  await runCommand('opencode', [
    'run',
    '--agent',
    agent,
    '--command',
    command,
    ...extraArgs,
    String(prNumber),
  ]);
}

export async function runAddressReview(prNumber: number): Promise<void> {
  await runCommand('opencode', [
    'run',
    '--agent',
    'implementer',
    '--command',
    'address-review',
    String(prNumber),
  ]);
}
