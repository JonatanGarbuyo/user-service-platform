import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (command: string, args: readonly string[]) => Promise<CommandResult>;

export async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: stdout, stderr: stderr };
}

export async function getCurrentHead(execute: CommandExecutor = runCommand): Promise<string> {
  const { stdout } = await execute('git', ['rev-parse', 'HEAD']);
  return stdout.trim();
}

export async function getCurrentBranch(execute: CommandExecutor = runCommand): Promise<string> {
  const { stdout } = await execute('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

export async function isWorktreeClean(execute: CommandExecutor = runCommand): Promise<boolean> {
  const { stdout } = await execute('git', ['status', '--porcelain']);
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

export async function getPrForBranch(
  prArg?: string,
  execute: CommandExecutor = runCommand,
): Promise<PrInfo> {
  const args =
    prArg !== undefined
      ? ['pr', 'view', prArg, '--json', 'number,headRefName,baseRefName,headRefOid']
      : ['pr', 'view', '--json', 'number,headRefName,baseRefName,headRefOid'];
  const { stdout } = await execute('gh', args);
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

export async function listPrComments(
  prNumber: number,
  execute: CommandExecutor = runCommand,
): Promise<PrComment[]> {
  const { stdout } = await execute('gh', [
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

export interface ReviewAxisWorker {
  command: ReviewAxisName;
}

// Pinned worker per axis for targeted marker retries (PR #17 blocker 1):
// only the axis missing its marker is relaunched, the other is left alone.
// The command frontmatter is the single source of truth for the configured
// subagent/model (ticket #18): Standards resolves to MiMo-V2.5 via
// `reviewer-standards`, Spec resolves to Nemotron 3.5 Lightning via
// `reviewer-spec`. Callers must not pass `--agent`.
export function reviewAxisWorker(axis: 'standards' | 'spec'): ReviewAxisWorker {
  if (axis === 'standards') {
    return { command: 'review-standards' };
  }
  return { command: 'review-spec' };
}

// Worker commands run with `opencode run --auto` so the review loop can run
// unattended (PR #17 blocker 1). Explicit `deny` permission rules in the agent
// definitions remain effective under `--auto`. No `--agent` flag is passed:
// each custom command's frontmatter already pins its subagent/model, and
// passing `--agent` with a subagent triggers an "subagent, not a primary
// agent" warning.
export function buildReviewAxisArgs(
  command: ReviewAxisName,
  prNumber: number,
  extraArgs: readonly string[] = [],
): string[] {
  return ['run', '--auto', '--command', command, ...extraArgs, String(prNumber)];
}

export function buildAddressReviewArgs(prNumber: number): string[] {
  return ['run', '--auto', '--command', 'address-review', String(prNumber)];
}

export async function runReviewAxis(
  command: ReviewAxisName,
  prNumber: number,
  extraArgs: readonly string[] = [],
  execute: CommandExecutor = runCommand,
): Promise<void> {
  await execute('opencode', buildReviewAxisArgs(command, prNumber, extraArgs));
}

export async function runAddressReview(
  prNumber: number,
  execute: CommandExecutor = runCommand,
): Promise<void> {
  await execute('opencode', buildAddressReviewArgs(prNumber));
}
