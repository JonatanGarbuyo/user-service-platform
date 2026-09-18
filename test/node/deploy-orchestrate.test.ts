import { describe, expect, it } from 'vitest';
import {
  planDeploymentSteps,
  productionConfirmFor,
  runDeployment,
  type DeployCommandRunner,
  type DeployIo,
} from '../../scripts/deploy/orchestrate.js';
import type { ResolvedDeployment } from '../../scripts/deploy/targets.js';
import {
  CONTRACT_PRODUCTION_DATABASE_ID,
  CONTRACT_SANDBOX_DATABASE_ID,
} from './deploy-test-utils.js';

const SANDBOX: ResolvedDeployment = {
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

const PRODUCTION: ResolvedDeployment = {
  ...SANDBOX,
  environment: 'production',
  workerName: 'rch-rugbychampagne-user-service-production',
  databaseName: 'rch-rugbychampagne-user-service-production-db',
  databaseId: CONTRACT_PRODUCTION_DATABASE_ID,
};

const CANARY = 'canary-deploy-secret-abcdef123456';

interface Harness {
  io: DeployIo;
  runner: DeployCommandRunner;
  commands: { command: string; args: string[] }[];
  removed: string[];
  logs: string[];
  preflightCalls: number;
}

function createHarness(failOn?: RegExp, failPreflight = false): Harness {
  const commands: { command: string; args: string[] }[] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  const harness: Harness = {
    io: {
      materialize: () => '/tmp/wrangler.deploy-test.json',
      cleanup: (path) => {
        removed.push(path);
      },
      preflight: () => {
        harness.preflightCalls += 1;
        if (failPreflight) {
          return Promise.reject(
            new Error('Deployment preflight failed: worktree: worktree has uncommitted changes.'),
          );
        }
        return Promise.resolve(undefined);
      },
      log: (message) => {
        logs.push(message);
      },
    },
    runner: (command, args) => {
      commands.push({ command, args: [...args] });
      const text = `${command} ${args.join(' ')}`;
      if (failOn?.test(text) === true) {
        return Promise.resolve({ exitCode: 1 });
      }
      return Promise.resolve({ exitCode: 0 });
    },
    commands,
    removed,
    logs,
    preflightCalls: 0,
  };
  return harness;
}

// Deployment orchestration (ticket #78): migrations precede Worker deployment,
// sandbox records the deployment and runs smoke, production needs an explicit
// confirmation and is never an automatic side effect. Temporary configs are
// always removed, even on failure.
describe('deployment orchestration', () => {
  it('plans the sandbox release in migration-first order with smoke last', () => {
    expect(planDeploymentSteps({ resolved: SANDBOX })).toEqual([
      'preflight',
      'validate-migrations-local',
      'migrate-remote',
      'deploy-worker',
      'record-deployment',
      'smoke-sandbox',
    ]);
  });

  it('plans production without smoke but with the deployment record', () => {
    const steps = planDeploymentSteps({
      resolved: PRODUCTION,
      confirm: productionConfirmFor(PRODUCTION),
    });
    expect(steps).toEqual([
      'preflight',
      'validate-migrations-local',
      'migrate-remote',
      'deploy-worker',
      'record-deployment',
    ]);
  });

  it('requires the production confirmation to equal the target Worker name', () => {
    expect(productionConfirmFor(PRODUCTION)).toBe('rch-rugbychampagne-user-service-production');
  });

  it('refuses production without confirmation before any remote mutation', async () => {
    const harness = createHarness();
    await expect(
      runDeployment({ resolved: PRODUCTION }, harness.io, harness.runner),
    ).rejects.toThrow(/rch-rugbychampagne-user-service-production/);
    expect(harness.commands).toEqual([]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('refuses production with the wrong confirmation before any remote mutation', async () => {
    const harness = createHarness();
    await expect(
      runDeployment({ resolved: PRODUCTION, confirm: 'PROMOTE' }, harness.io, harness.runner),
    ).rejects.toThrow(/confirmation/);
    expect(harness.commands).toEqual([]);
  });

  it('runs migrations before Worker deployment for sandbox', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.io, harness.runner);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    const migrateIndex = text.findIndex((entry) => entry.includes('migrations apply DB --remote'));
    const deployIndex = text.findIndex((entry) => entry.includes('wrangler deploy'));
    const smokeIndex = text.findIndex((entry) => entry.includes('smoke:sandbox'));
    expect(migrateIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(migrateIndex);
    expect(smokeIndex).toBeGreaterThan(deployIndex);
    expect(text.some((entry) => entry.includes('--config /tmp/wrangler.deploy-test.json'))).toBe(
      true,
    );
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('validates migrations locally before remote mutation', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.io, harness.runner);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    const localIndex = text.findIndex((entry) => entry.includes('migrations apply DB --local'));
    const remoteIndex = text.findIndex((entry) => entry.includes('migrations apply DB --remote'));
    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(localIndex).toBeLessThan(remoteIndex);
  });

  it('removes the temporary config even when deployment fails', async () => {
    const harness = createHarness(/wrangler deploy/);
    await expect(runDeployment({ resolved: SANDBOX }, harness.io, harness.runner)).rejects.toThrow(
      /deploy-worker/,
    );
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('runs zero remote commands for a dry run', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX, dryRun: true }, harness.io, harness.runner);
    expect(harness.commands).toEqual([]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
    expect(harness.logs.join('\n')).toContain('rch-rugbychampagne-user-service-sandbox');
  });

  it('executes the read-only preflight on a dry run without mutating commands', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX, dryRun: true }, harness.io, harness.runner);
    expect(harness.preflightCalls).toBe(1);
    expect(harness.commands).toEqual([]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('fails the dry run when preflight fails and still cleans up', async () => {
    const harness = createHarness(undefined, true);
    await expect(
      runDeployment({ resolved: SANDBOX, dryRun: true }, harness.io, harness.runner),
    ).rejects.toThrow(/preflight/);
    expect(harness.preflightCalls).toBe(1);
    expect(harness.commands).toEqual([]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('never logs secret values while summarizing the deployment', async () => {
    const harness = createHarness();
    process.env.DEPLOY_CLI_CANARY = CANARY;
    try {
      await runDeployment({ resolved: SANDBOX, dryRun: true }, harness.io, harness.runner);
    } finally {
      delete process.env.DEPLOY_CLI_CANARY;
    }
    expect(harness.logs.join('\n')).not.toContain(CANARY);
  });
});
