import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  configureRemoteAgentGitIdentity,
  GITHUB_ACTIONS_BOT_IDENTITY,
} from '../../scripts/agent/git-identity.js';

describe('remote agent Git identity', () => {
  it('is a no-op outside GitHub Actions', () => {
    const calls: string[][] = [];

    expect(
      configureRemoteAgentGitIdentity({
        githubActions: 'false',
        runGit: (args) => calls.push([...args]),
      }),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it('configures the repository-local GitHub Actions bot identity on hosted runs', () => {
    const calls: string[][] = [];

    expect(
      configureRemoteAgentGitIdentity({
        githubActions: 'true',
        runGit: (args) => calls.push([...args]),
      }),
    ).toBe(true);

    expect(calls).toEqual([
      ['config', '--local', 'user.name', GITHUB_ACTIONS_BOT_IDENTITY.name],
      ['config', '--local', 'user.email', GITHUB_ACTIONS_BOT_IDENTITY.email],
    ]);
    expect(calls.flat()).not.toContain('--global');
    expect(GITHUB_ACTIONS_BOT_IDENTITY).toEqual({
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
    });
  });

  it('wires the setup through npm before every agent:ticket run', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['preagent:ticket']).toBe(
      'tsx scripts/configure-agent-git-identity.ts',
    );
    expect(packageJson.scripts?.['agent:ticket']).toBe('tsx scripts/agent-ticket.ts');
  });
});
