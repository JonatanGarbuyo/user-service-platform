import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASE_COMPATIBILITY_DATE,
  BASE_COMPATIBILITY_FLAGS,
  BASE_OBSERVABILITY,
  BASE_WORKER_MAIN,
  buildTargetWranglerConfig,
  removeTempWranglerConfig,
  writeTempWranglerConfig,
} from '../../scripts/deploy/materialize.js';
import type { ResolvedDeployment } from '../../scripts/deploy/targets.js';
import {
  CONTRACT_PRODUCTION_DATABASE_ID,
  CONTRACT_SANDBOX_DATABASE_ID,
} from './deploy-test-utils.js';

const SANDBOX_RESOLVED: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: CONTRACT_SANDBOX_DATABASE_ID,
  vars: {
    AUTH_MAIL_TRANSPORT: 'resend',
    AUTH_MAIL_FROM: 'User Service <jg@ingalatech.com>',
    AUTH_MAIL_ALLOWLIST: 'jonatangarbuyo@gmail.com,jg@ingalatech.com',
  },
};

// Temporary Wrangler materialization (ticket #78): the deployer derives one
// target-specific config from the base application config plus the selected
// target. Application code keeps using the stable `DB` binding while the
// physical D1 stays target-specific.
describe('wrangler config materialization', () => {
  it('tracks the base application config instead of drifting from it', () => {
    const base = readFileSync('wrangler.jsonc', 'utf8');
    expect(base).toContain(`"compatibility_date": "${BASE_COMPATIBILITY_DATE}"`);
    for (const flag of BASE_COMPATIBILITY_FLAGS) {
      expect(base).toContain(flag);
    }
    expect(base).toContain(`"main": "${BASE_WORKER_MAIN}"`);
    expect(BASE_OBSERVABILITY).toEqual({ enabled: true });
    expect(base).toContain('"enabled": true');
  });

  it('materializes a target-specific config with the stable DB binding', () => {
    const config = buildTargetWranglerConfig(SANDBOX_RESOLVED);
    expect(config.name).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(config.d1_databases).toEqual([
      {
        binding: 'DB',
        database_name: 'rch-rugbychampagne-user-service-sandbox-db',
        database_id: CONTRACT_SANDBOX_DATABASE_ID,
        migrations_dir: 'drizzle',
      },
    ]);
    expect(config.vars).toMatchObject({
      ENVIRONMENT: 'sandbox',
      AUTH_MAIL_TRANSPORT: 'resend',
      AUTH_MAIL_FROM: 'User Service <jg@ingalatech.com>',
      AUTH_MAIL_ALLOWLIST: 'jonatangarbuyo@gmail.com,jg@ingalatech.com',
    });
  });

  it('never materializes secret keys into the generated config', () => {
    const config = buildTargetWranglerConfig(SANDBOX_RESOLVED);
    const serialized = JSON.stringify(config);
    for (const secret of ['BETTER_AUTH_SECRET', 'RESEND_API_KEY', 'SMTP_USER', 'SMTP_PASSWORD']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('binds a distinct D1 per target environment while keeping the DB binding', () => {
    const production = buildTargetWranglerConfig({
      ...SANDBOX_RESOLVED,
      environment: 'production',
      workerName: 'rch-rugbychampagne-user-service-production',
      databaseName: 'rch-rugbychampagne-user-service-production-db',
      databaseId: CONTRACT_PRODUCTION_DATABASE_ID,
      vars: { AUTH_MAIL_TRANSPORT: 'resend' },
    });
    const sandboxDatabases = (configOf(buildTargetWranglerConfig(SANDBOX_RESOLVED)) ?? []) as {
      database_id: string;
    }[];
    const productionDatabases = (configOf(production) ?? []) as { database_id: string }[];
    expect(sandboxDatabases[0]?.database_id).not.toBe(productionDatabases[0]?.database_id);
    expect(production.vars).toMatchObject({ ENVIRONMENT: 'production' });
  });

  it('writes and removes the temporary config around deployment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-materialize-test-'));
    try {
      const path = writeTempWranglerConfig(SANDBOX_RESOLVED, directory);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown };
      expect(parsed.name).toBe('rch-rugbychampagne-user-service-sandbox');
      removeTempWranglerConfig(path);
      expect(() => readFileSync(path, 'utf8')).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('tolerates removing an already-missing temporary config', () => {
    expect(() => {
      removeTempWranglerConfig(join(tmpdir(), 'deploy-materialize-missing.json'));
    }).not.toThrow();
  });
});

function configOf(config: unknown): unknown {
  if (typeof config === 'object' && config !== null) {
    return (config as { d1_databases?: unknown }).d1_databases;
  }
  return undefined;
}
