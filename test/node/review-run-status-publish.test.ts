import { describe, expect, it } from 'vitest';
import {
  buildStatusUpdateArgs,
  publishStatusUpdate,
  readStatusEnv,
  type StatusEnv,
} from '../../scripts/review/run-status.js';

// Seam under test: GitHub status publication (ticket #31).
// Stage updates PATCH one durable status comment through `gh api`; terminal
// states are always published; publication is best-effort and never changes
// the orchestration outcome.
function env(): StatusEnv {
  return {
    commentId: 999,
    repoSlug: 'o/r',
    runUrl: 'https://github.com/o/r/actions/runs/123',
  };
}

describe('run status environment', () => {
  it('reads the status comment, repo slug, and run URL from the environment', () => {
    const parsed = readStatusEnv({
      AGENT_RUN_STATUS_COMMENT_ID: '999',
      GITHUB_REPOSITORY: 'o/r',
      AGENT_RUN_URL: 'https://github.com/o/r/actions/runs/123',
    });

    expect(parsed).toEqual(env());
  });

  it('stays silent when the status surface is not configured', () => {
    expect(readStatusEnv({})).toBeUndefined();
    expect(readStatusEnv({ AGENT_RUN_STATUS_COMMENT_ID: '999' })).toBeUndefined();
    expect(
      readStatusEnv({ AGENT_RUN_STATUS_COMMENT_ID: 'abc', GITHUB_REPOSITORY: 'o/r' }),
    ).toBeUndefined();
  });
});

describe('run status publication', () => {
  it('PATCHes the single status comment with the deterministic body', async () => {
    const seen: { command: string; args: readonly string[] }[] = [];
    const ok = await publishStatusUpdate(
      (command, args) => {
        seen.push({ command, args: [...args] });
        return Promise.resolve({ stdout: '', stderr: '' });
      },
      env(),
      'Target: issue #31\n',
    );

    expect(ok).toBe(true);
    expect(seen).toEqual([
      { command: 'gh', args: buildStatusUpdateArgs(env(), 'Target: issue #31\n') },
    ]);
    expect(buildStatusUpdateArgs(env(), 'body').slice(0, 3)).toEqual([
      'api',
      'repos/o/r/issues/comments/999',
      '--method',
    ]);
  });

  it('reports failure without throwing when the update is refused', async () => {
    const ok = await publishStatusUpdate(
      () => Promise.reject(new Error('network down')),
      env(),
      'body',
    );

    expect(ok).toBe(false);
  });
});
