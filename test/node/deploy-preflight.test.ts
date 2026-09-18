import { describe, expect, it } from 'vitest';
import {
  formatPreflightError,
  preflightFailed,
  runPreflight,
  type PreflightCommand,
  type PreflightDeps,
} from '../../scripts/deploy/preflight.js';
import type { ResolvedDeployment } from '../../scripts/deploy/targets.js';
import { CONTRACT_SANDBOX_DATABASE_ID } from './deploy-test-utils.js';

const RESOLVED: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: CONTRACT_SANDBOX_DATABASE_ID,
  vars: { AUTH_MAIL_TRANSPORT: 'resend' },
};

const CANARY_API_TOKEN = 'canary-cloudflare-token-abcdef123456';
const CANARY_AUTH_SECRET = 'canary-better-auth-secret-7890';

function passingDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  const commands: PreflightCommand[] = [];
  return {
    nodeVersion: 'v24.21.0',
    commands,
    run: (command, args) => {
      commands.push({ command, args: [...args] });
      if (command === 'git') {
        return Promise.resolve({ exitCode: 0, stdout: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: 'ok' });
    },
    ...overrides,
  };
}

// Deployment preflight (ticket #78): every remote mutation is preceded by
// Node/Wrangler/auth/account, worktree, target-config and resource checks.
// Secret values are never inspected, printed, or uploaded.
describe('deployment preflight', () => {
  it('passes for a provisioned target in a clean authenticated worktree', async () => {
    const deps = passingDeps();
    const checks = await runPreflight({ resolved: RESOLVED }, deps);
    expect(preflightFailed(checks)).toBe(false);
    expect(checks.map((check) => check.name)).toEqual([
      'node',
      'wrangler',
      'cloudflare-auth',
      'account-access',
      'worktree',
      'target-config',
      'worker-name',
    ]);
  });

  it('refuses when Cloudflare account access fails', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({
        run: (command, args) => {
          if (args.includes('d1')) {
            return Promise.resolve({ exitCode: 1, stdout: 'forbidden' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '' });
        },
      }),
    );
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/account/i);
  });

  it('performs no remote mutation during preflight', async () => {
    const deps = passingDeps();
    await runPreflight({ resolved: RESOLVED }, deps);
    for (const { command, args } of deps.commands) {
      expect(`${command} ${args.join(' ')}`).not.toMatch(/deploy|migrate|delete|secret/);
    }
  });

  it('refuses outdated Node runtimes', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({ nodeVersion: 'v22.14.0' }),
    );
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/node/i);
  });

  it('refuses when Wrangler is unavailable', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({
        run: (command, args) => {
          if (command === 'npx' && args[1] === '--version') {
            return Promise.resolve({ exitCode: 1, stdout: 'no wrangler' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '' });
        },
      }),
    );
    expect(preflightFailed(checks)).toBe(true);
  });

  it('refuses when Cloudflare authentication fails', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({
        run: (command, args) => {
          if (args.includes('whoami')) {
            return Promise.resolve({ exitCode: 1, stdout: 'not logged in' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '' });
        },
      }),
    );
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/auth/i);
  });

  it('refuses a dirty worktree before remote mutation', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({
        run: (command) => {
          if (command === 'git') {
            return Promise.resolve({ exitCode: 0, stdout: 'M wrangler.jsonc\n' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '' });
        },
      }),
    );
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/worktree/i);
  });

  it('refuses an unprovisioned database id', async () => {
    const checks = await runPreflight({ resolved: { ...RESOLVED, databaseId: '' } }, passingDeps());
    expect(preflightFailed(checks)).toBe(true);
  });

  it('never leaks secret values into preflight results', async () => {
    const deps = passingDeps({
      run: () =>
        Promise.resolve({
          exitCode: 1,
          stdout: `token ${CANARY_API_TOKEN} secret ${CANARY_AUTH_SECRET}`,
        }),
    });
    const checks = await runPreflight({ resolved: RESOLVED }, deps);
    expect(preflightFailed(checks)).toBe(true);
    const serialized = JSON.stringify(checks);
    expect(serialized).not.toContain(CANARY_API_TOKEN);
    expect(serialized).not.toContain(CANARY_AUTH_SECRET);
  });
});
