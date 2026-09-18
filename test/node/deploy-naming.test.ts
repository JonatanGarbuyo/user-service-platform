import { describe, expect, it } from 'vitest';
import {
  assertWorkerName,
  databaseName,
  deploymentKey,
  MAX_WORKER_NAME_LENGTH,
  parseDeployEnvironment,
  resourceName,
  workerName,
} from '../../scripts/deploy/naming.js';

// Deterministic deployment naming (ticket #78): every Worker and Cloudflare
// resource name derives from `<company>-<site>-<service>-<environment>` with
// explicit resource suffixes. Canonical environments are sandbox/production
// only; `staging` is never offered.
describe('deployment naming', () => {
  const rchSandbox = {
    company: 'rch',
    site: 'rugbychampagne',
    service: 'user-service',
    environment: 'sandbox' as const,
  };

  it('derives the canonical deployment key for the first RCH target', () => {
    expect(deploymentKey(rchSandbox)).toBe('rch-rugbychampagne-user-service-sandbox');
  });

  it('uses the deployment key as the Worker name', () => {
    expect(workerName(rchSandbox)).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(workerName({ ...rchSandbox, environment: 'production' })).toBe(
      'rch-rugbychampagne-user-service-production',
    );
  });

  it('derives the D1 resource name with an explicit -db suffix', () => {
    expect(databaseName(rchSandbox)).toBe('rch-rugbychampagne-user-service-sandbox-db');
  });

  it('derives future stateful resources with explicit suffixes', () => {
    const key = deploymentKey(rchSandbox);
    expect(resourceName(key, 'db')).toBe(`${key}-db`);
    expect(resourceName(key, 'session')).toBe(`${key}-session`);
    expect(resourceName(key, 'files')).toBe(`${key}-files`);
  });

  it('rejects unknown resource suffixes instead of adding positional segments', () => {
    expect(() => resourceName(deploymentKey(rchSandbox), 'cache')).toThrow(/suffix/);
  });

  it('accepts only the canonical deployable environments', () => {
    expect(parseDeployEnvironment('sandbox')).toBe('sandbox');
    expect(parseDeployEnvironment('production')).toBe('production');
  });

  it('rejects staging explicitly', () => {
    expect(() => parseDeployEnvironment('staging')).toThrow(/staging/i);
  });

  it('rejects local, test and unknown environments for deployment', () => {
    for (const value of ['local', 'test', 'prod', '', 'SANDBOX ']) {
      if (value === 'SANDBOX ') {
        expect(parseDeployEnvironment(value)).toBe('sandbox');
        continue;
      }
      expect(() => parseDeployEnvironment(value)).toThrow(/environment/i);
    }
  });

  it('rejects Worker names over the 63-character workers.dev DNS-label limit', () => {
    expect(MAX_WORKER_NAME_LENGTH).toBe(63);
    const overlong = 'a234567890123456789012345678901234567890123456789012345678901234';
    expect(overlong.length).toBeGreaterThan(63);
    expect(() => {
      assertWorkerName(overlong);
    }).toThrow(/63/);
    expect(() =>
      workerName({
        company: 'very-long-company-slug-here',
        site: 'very-long-site-slug-here-too',
        service: 'user-service',
        environment: 'production',
      }),
    ).toThrow(/63/);
  });

  it('accepts a Worker name at exactly 63 characters', () => {
    const exact = `a${'b'.repeat(61)}c`;
    expect(exact.length).toBe(63);
    expect(() => {
      assertWorkerName(exact);
    }).not.toThrow();
  });

  it('rejects Worker names that are not DNS labels', () => {
    for (const name of ['Upper-Case', 'has_underscore', '-leading', 'trailing-', 'has space']) {
      expect(() => {
        assertWorkerName(name);
      }).toThrow();
    }
  });

  it('rejects empty or malformed identity slugs', () => {
    expect(() =>
      workerName({
        company: '',
        site: 'rugbychampagne',
        service: 'user-service',
        environment: 'sandbox' as const,
      }),
    ).toThrow(/company/);
    expect(() =>
      workerName({
        company: 'RCH',
        site: 'rugbychampagne',
        service: 'user-service',
        environment: 'sandbox' as const,
      }),
    ).toThrow(/company/);
    expect(() =>
      workerName({
        company: 'rch',
        site: 'rugby champagne',
        service: 'user-service',
        environment: 'sandbox' as const,
      }),
    ).toThrow(/site/);
  });
});
