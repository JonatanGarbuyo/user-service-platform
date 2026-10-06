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

export interface BoundedCommandOptions {
  timeoutMs: number;
  maxBufferBytes: number;
  killSignal?: NodeJS.Signals;
}

// Bounded read-only subprocess seam (ticket #116): unlike `runCommand`, the
// child is terminated on timeout (`timeout` kills with `killSignal`) and
// output is capped at `maxBufferBytes`, so a hung or gigantic session export
// can neither stall the worker nor exhaust memory. Rejections (including
// timeout kills) carry the command context without payload contents.
export async function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      maxBuffer: options.maxBufferBytes,
      timeout: options.timeoutMs,
      killSignal: options.killSignal ?? 'SIGTERM',
    });
    return { stdout: stdout, stderr: stderr };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `bounded command ${command} ${args.join(' ')} failed: ${detail.slice(0, 200)}`,
      {
        cause: error,
      },
    );
  }
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
  url?: string;
}

interface GhPrView {
  number: number;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  url?: unknown;
}

export async function getPrForBranch(
  prArg?: string,
  execute: CommandExecutor = runCommand,
): Promise<PrInfo> {
  const args =
    prArg !== undefined
      ? ['pr', 'view', prArg, '--json', 'number,headRefName,baseRefName,headRefOid,url']
      : ['pr', 'view', '--json', 'number,headRefName,baseRefName,headRefOid,url'];
  const { stdout } = await execute('gh', args);
  const parsed = JSON.parse(stdout) as GhPrView;
  return {
    number: parsed.number,
    headRefName: parsed.headRefName,
    baseRefName: parsed.baseRefName,
    headRefOid: parsed.headRefOid,
    ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}),
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
// subagent/model (ticket #18): Standards resolves to MiMo-V2.6-Flash via
// `reviewer-standards`, Spec resolves to Muse Spark 1.3 Contributor Free via
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
// agent" warning. `--format json` streams real pinned CLI tool records for
// attributable skill evidence (ticket #116) without changing model, agent or
// permission resolution.
//
// The flag is additive through a single helper so the shipped builders share
// one seam: frontmatter model/agent resolution, permissions and live
// streaming behavior are unchanged.
export function withJsonFormat(args: readonly string[]): string[] {
  if (args.includes('--format')) {
    return [...args];
  }
  const autoIndex = args.indexOf('--auto');
  if (autoIndex >= 0) {
    return [...args.slice(0, autoIndex + 1), '--format', 'json', ...args.slice(autoIndex + 1)];
  }
  return [...args, '--format', 'json'];
}

export function buildReviewAxisArgs(
  command: ReviewAxisName,
  prNumber: number,
  extraArgs: readonly string[] = [],
): string[] {
  return withJsonFormat(['run', '--auto', '--command', command, ...extraArgs, String(prNumber)]);
}

export function buildAddressReviewArgs(prNumber: number): string[] {
  return withJsonFormat(['run', '--auto', '--command', 'address-review', String(prNumber)]);
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
