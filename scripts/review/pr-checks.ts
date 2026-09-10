import { runCommand, type CommandExecutor } from './runner.js';

export interface CommitCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

// Exact-SHA CI verification (PR #17 final acceptance blockers). The READY
// path must confirm the checks attached to the reviewed commit itself — the
// PR rollup alone cannot prove the local HEAD is what CI ran. An empty run
// list (checks not registered yet) is never a pass.
export function commitChecksPass(runs: CommitCheckRun[]): boolean {
  return (
    runs.length > 0 &&
    runs.every((run) => run.status === 'completed' && run.conclusion === 'success')
  );
}

export type CheckPollDecision = 'pass' | 'fail' | 'pending';

export const CHECK_POLL_ATTEMPTS = 12;
export const CHECK_POLL_DELAY_MS = 10000;

// Polling policy for exact-SHA checks: pending/absent runs wait, a completed
// non-success fails fast, and only a non-empty all-success set passes.
export function decideCheckPoll(runs: CommitCheckRun[]): CheckPollDecision {
  if (runs.some((run) => run.status === 'completed' && run.conclusion !== 'success')) {
    return 'fail';
  }
  if (commitChecksPass(runs)) {
    return 'pass';
  }
  return 'pending';
}

interface GhCheckRun {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
}

export async function fetchCommitCheckRuns(
  repoSlug: string,
  headSha: string,
  execute: CommandExecutor = runCommand,
): Promise<CommitCheckRun[]> {
  const { stdout } = await execute('gh', [
    'api',
    `repos/${repoSlug}/commits/${headSha}/check-runs`,
    '--jq',
    '.check_runs[] | {name: .name, status: .status, conclusion: .conclusion}',
  ]);
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  const runs: CommitCheckRun[] = [];
  for (const line of trimmed.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = JSON.parse(line) as GhCheckRun;
    if (typeof parsed.name === 'string' && typeof parsed.status === 'string') {
      runs.push({
        name: parsed.name,
        status: parsed.status,
        conclusion: typeof parsed.conclusion === 'string' ? parsed.conclusion : null,
      });
    }
  }
  return runs;
}

export async function getRepoSlug(execute: CommandExecutor = runCommand): Promise<string> {
  const { stdout } = await execute('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
  return stdout.trim();
}
