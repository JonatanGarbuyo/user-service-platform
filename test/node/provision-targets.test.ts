import { describe, expect, it } from 'vitest';
import {
  loadTargetsFile,
  resolveProvisioningTarget,
  resolveTargetDeployment,
  type TargetsFile,
} from '../../scripts/deploy/targets.js';
import { loadTargetsFromRepo } from './deploy-test-utils.js';

// Provisioning target resolution (ticket #80): provisioning accepts an empty
// database id so first-time targets can be discovered/created, while the
// deployment boundary keeps refusing unprovisioned ids.
describe('provisioning target resolution', () => {
  it('resolves the RCH sandbox target with an empty database id', () => {
    const file = loadTargetsFromRepo();
    const unprovisioned: TargetsFile = {
      ...file,
      targets: file.targets.map((entry) => ({
        ...entry,
        environments: {
          ...entry.environments,
          sandbox: { ...entry.environments.sandbox, databaseId: '' },
        },
      })),
    };
    const resolved = resolveProvisioningTarget(unprovisioned, {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    expect(resolved.workerName).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(resolved.databaseName).toBe('rch-rugbychampagne-user-service-sandbox-db');
    expect(resolved.databaseId).toBe('');
  });

  it('resolves the RCH production target with an empty database id', () => {
    const file = loadTargetsFromRepo();
    const unprovisioned: TargetsFile = {
      ...file,
      targets: file.targets.map((entry) => ({
        ...entry,
        environments: {
          ...entry.environments,
          production: { ...entry.environments.production, databaseId: '' },
        },
      })),
    };
    const resolved = resolveProvisioningTarget(unprovisioned, {
      target: 'rch-rugbychampagne',
      environment: 'production',
    });
    expect(resolved.workerName).toBe('rch-rugbychampagne-user-service-production');
    expect(resolved.databaseName).toBe('rch-rugbychampagne-user-service-production-db');
  });

  it('keeps the deployment gate closed for the same unprovisioned id', () => {
    const file = loadTargetsFromRepo();
    const unprovisioned: TargetsFile = {
      ...file,
      targets: file.targets.map((entry) => ({
        ...entry,
        environments: {
          ...entry.environments,
          sandbox: { ...entry.environments.sandbox, databaseId: '' },
        },
      })),
    };
    expect(() =>
      resolveTargetDeployment(unprovisioned, {
        target: 'rch-rugbychampagne',
        environment: 'sandbox',
      }),
    ).toThrow(/provision/i);
  });

  it('rejects unknown targets without prefix inference', () => {
    const file = loadTargetsFromRepo();
    for (const unknown of ['rch', 'rugbychampagne', 'rch-rugbychampagne-sandbox']) {
      expect(() =>
        resolveProvisioningTarget(file, { target: unknown, environment: 'sandbox' }),
      ).toThrow(/rch-rugbychampagne/);
    }
  });

  it('rejects staging for provisioning', () => {
    expect(() =>
      resolveProvisioningTarget(loadTargetsFromRepo(), {
        target: 'rch-rugbychampagne',
        environment: 'staging',
      }),
    ).toThrow(/staging/i);
  });

  it('preserves the target non-secret vars for provisioning', () => {
    const resolved = resolveProvisioningTarget(loadTargetsFromRepo(), {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    expect(resolved.vars.AUTH_MAIL_TRANSPORT).toBe('smtp');
  });

  it('rejects malformed target files', () => {
    expect(() => loadTargetsFile(null)).toThrow();
  });
});
