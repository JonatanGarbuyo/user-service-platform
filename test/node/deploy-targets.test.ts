import { describe, expect, it } from 'vitest';
import {
  loadTargetsFile,
  resolveTargetDeployment,
  type TargetsFile,
} from '../../scripts/deploy/targets.js';
import { loadTargetsFromRepo, provisionedTargetsForContract } from './deploy-test-utils.js';

function readTargetsFile(): TargetsFile {
  return loadTargetsFromRepo();
}

// Real database ids are provisioned out-of-band and recorded in
// deploy/targets.json (see docs/operations/sandbox-release-runbook.md), so
// resolution tests run against a provisioned copy of the versioned file.
function provisionedCopy(file: TargetsFile): TargetsFile {
  return provisionedTargetsForContract(file);
}

const CANARY = 'canary-secret-value-9f8e7d6c5b4a';

// Versioned secret-free deployment targets (ticket #78): one file owns every
// company/site target; application code never hard-codes RCH behavior.
describe('deployment targets', () => {
  it('loads the versioned target file with the first RCH target', () => {
    const targets = readTargetsFile();
    expect(targets.version).toBe(1);
    expect(targets.service).toBe('user-service');
    expect(targets.targets.map((target) => target.key)).toContain('rch-rugbychampagne');
  });

  it('resolves the RCH sandbox deployment with the ticket mail values', () => {
    const resolved = resolveTargetDeployment(provisionedCopy(readTargetsFile()), {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    expect(resolved.workerName).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(resolved.environment).toBe('sandbox');
    expect(resolved.vars.AUTH_MAIL_TRANSPORT).toBe('resend');
    expect(resolved.vars.AUTH_MAIL_FROM).toBe('User Service <jg@ingalatech.com>');
    expect(resolved.vars.AUTH_MAIL_ALLOWLIST).toBe('jonatangarbuyo@gmail.com,jg@ingalatech.com');
  });

  it('resolves the RCH production worker name deterministically', () => {
    const resolved = resolveTargetDeployment(provisionedCopy(readTargetsFile()), {
      target: 'rch-rugbychampagne',
      environment: 'production',
    });
    expect(resolved.workerName).toBe('rch-rugbychampagne-user-service-production');
  });

  it('rejects unknown targets and lists the available keys', () => {
    expect(() =>
      resolveTargetDeployment(readTargetsFile(), {
        target: 'unknown-site',
        environment: 'sandbox',
      }),
    ).toThrow(/rch-rugbychampagne/);
  });

  it('rejects staging as a deployment environment', () => {
    expect(() =>
      resolveTargetDeployment(readTargetsFile(), {
        target: 'rch-rugbychampagne',
        environment: 'staging',
      }),
    ).toThrow(/staging/i);
  });

  it('rejects target vars that carry runtime secrets without echoing values', () => {
    for (const secret of [
      'BETTER_AUTH_SECRET',
      'RESEND_API_KEY',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'CLOUDFLARE_API_TOKEN',
    ]) {
      const file = readTargetsFile();
      const target = file.targets.find((entry) => entry.key === 'rch-rugbychampagne');
      expect(target).toBeDefined();
      const poisoned: TargetsFile = {
        ...file,
        targets: file.targets.map((entry) =>
          entry.key === 'rch-rugbychampagne'
            ? {
                ...entry,
                environments: {
                  ...entry.environments,
                  sandbox: {
                    ...entry.environments.sandbox,
                    vars: { ...entry.environments.sandbox.vars, [secret]: CANARY },
                  },
                },
              }
            : entry,
        ),
      };
      let message = '';
      try {
        loadTargetsFile(poisoned);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(new RegExp(secret));
      expect(message).not.toContain(CANARY);
    }
  });

  it('rejects unknown and ENVIRONMENT vars in target configuration', () => {
    const file = readTargetsFile();
    const withUnknown: TargetsFile = {
      ...file,
      targets: file.targets.map((entry) => ({
        ...entry,
        environments: {
          ...entry.environments,
          sandbox: {
            ...entry.environments.sandbox,
            vars: { ...entry.environments.sandbox.vars, MADE_UP_VAR: 'x' },
          },
        },
      })),
    };
    expect(() => loadTargetsFile(withUnknown)).toThrow(/MADE_UP_VAR/);
  });

  it('requires a provisioned D1 database id before resolving', () => {
    const file = readTargetsFile();
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

  it('rejects placeholder database ids rather than deploying against them', () => {
    const file = readTargetsFile();
    const placeholder: TargetsFile = {
      ...file,
      targets: file.targets.map((entry) => ({
        ...entry,
        environments: {
          ...entry.environments,
          sandbox: {
            ...entry.environments.sandbox,
            databaseId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        },
      })),
    };
    expect(() =>
      resolveTargetDeployment(placeholder, {
        target: 'rch-rugbychampagne',
        environment: 'sandbox',
      }),
    ).toThrow(/provision|placeholder/i);
  });

  it('rejects malformed target files', () => {
    expect(() => loadTargetsFile(null)).toThrow();
    expect(() => loadTargetsFile({ version: 2, targets: [] })).toThrow(/version/);
    expect(() => loadTargetsFile({ version: 1, targets: [] })).toThrow(/target/);
  });
});
