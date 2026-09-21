import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTargetWranglerConfig } from '../../scripts/deploy/materialize.js';
import { requiredWorkerSecrets } from '../../scripts/deploy/secrets.js';
import { resolveTargetDeployment } from '../../scripts/deploy/targets.js';
import type { ResolvedDeployment } from '../../scripts/deploy/targets.js';
import {
  CONTRACT_PRODUCTION_DATABASE_ID,
  CONTRACT_SANDBOX_DATABASE_ID,
  loadTargetsFromRepo,
} from './deploy-test-utils.js';

function resolved(
  environment: 'sandbox' | 'production',
  vars: Record<string, string>,
  targetKey = 'rch-rugbychampagne',
): ResolvedDeployment {
  return {
    targetKey,
    company: 'rch',
    site: 'rugbychampagne',
    service: 'user-service',
    environment,
    workerName: `${targetKey}-user-service-${environment}`,
    databaseName: `${targetKey}-user-service-${environment}-db`,
    databaseId:
      environment === 'sandbox' ? CONTRACT_SANDBOX_DATABASE_ID : CONTRACT_PRODUCTION_DATABASE_ID,
    vars,
  };
}

// Required Worker secrets (ticket #104): `wrangler deploy` must fail closed
// before Worker promotion/smoke when a required secret name is missing.
// Names only; values never enter versioned config, generated config, or logs.
describe('required worker secrets', () => {
  it('requires auth + SMTP secrets for a sandbox SMTP deployment', () => {
    expect(
      requiredWorkerSecrets({
        environment: 'sandbox',
        vars: { AUTH_MAIL_TRANSPORT: 'smtp' },
      }),
    ).toEqual(['BETTER_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASSWORD']);
  });

  it('requires auth + Resend secrets for a production Resend deployment', () => {
    expect(
      requiredWorkerSecrets({
        environment: 'production',
        vars: { AUTH_MAIL_TRANSPORT: 'resend' },
      }),
    ).toEqual(['BETTER_AUTH_SECRET', 'RESEND_API_KEY']);
  });

  it('derives requirements from effective transport, not target identity', () => {
    expect(
      requiredWorkerSecrets({
        environment: 'sandbox',
        vars: { AUTH_MAIL_TRANSPORT: 'resend' },
      }),
    ).toEqual(['BETTER_AUTH_SECRET', 'RESEND_API_KEY']);
    expect(
      requiredWorkerSecrets({
        environment: 'production',
        vars: { AUTH_MAIL_TRANSPORT: 'smtp' },
      }),
    ).toEqual(['BETTER_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASSWORD']);
  });

  it('keeps local credential-free without a real provider selected', () => {
    expect(requiredWorkerSecrets({ environment: 'local', vars: {} })).toEqual([]);
    expect(
      requiredWorkerSecrets({ environment: 'local', vars: { AUTH_MAIL_TRANSPORT: 'inmemory' } }),
    ).toEqual([]);
  });

  it('requires only provider secrets when local opts into a real transport', () => {
    expect(
      requiredWorkerSecrets({ environment: 'local', vars: { AUTH_MAIL_TRANSPORT: 'smtp' } }),
    ).toEqual(['SMTP_USER', 'SMTP_PASSWORD']);
    expect(
      requiredWorkerSecrets({ environment: 'local', vars: { AUTH_MAIL_TRANSPORT: 'resend' } }),
    ).toEqual(['RESEND_API_KEY']);
  });

  it('materializes secrets.required for the RCH sandbox SMTP target', () => {
    const config = buildTargetWranglerConfig(
      resolved('sandbox', {
        AUTH_MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
      }),
    );
    expect(config.secrets).toEqual({
      required: ['BETTER_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASSWORD'],
    });
  });

  it('declares exactly the SMTP secret set for the versioned RCH sandbox target', () => {
    const resolved = resolveTargetDeployment(loadTargetsFromRepo(), {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    expect(resolved.vars.AUTH_MAIL_TRANSPORT).toBe('smtp');
    const config = buildTargetWranglerConfig(resolved);
    expect(config.secrets).toEqual({
      required: ['BETTER_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASSWORD'],
    });
  });

  it('tracks the pinned Wrangler secrets.required config property', () => {
    const schema = JSON.parse(readFileSync('node_modules/wrangler/config-schema.json', 'utf8')) as {
      definitions?: {
        RawConfig?: {
          properties?: { secrets?: { properties?: { required?: { type?: unknown } } } };
        };
      };
    };
    expect(schema.definitions?.RawConfig?.properties?.secrets?.properties?.required?.type).toBe(
      'array',
    );
  });

  it('materializes secrets.required for a Resend production target', () => {
    const config = buildTargetWranglerConfig(
      resolved('production', { AUTH_MAIL_TRANSPORT: 'resend' }),
    );
    expect(config.secrets).toEqual({ required: ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'] });
  });

  it('never carries secret values in the materialized config', () => {
    const config = buildTargetWranglerConfig(resolved('sandbox', { AUTH_MAIL_TRANSPORT: 'smtp' }));
    const serialized = JSON.stringify(config);
    expect(serialized).toContain('BETTER_AUTH_SECRET');
    expect(serialized).toContain('SMTP_USER');
    expect(serialized).toContain('SMTP_PASSWORD');
    expect(serialized).not.toContain('canary');
  });
});
