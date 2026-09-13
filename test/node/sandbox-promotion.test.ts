import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertSafeSmokeTarget,
  assertSandboxSmokeEmail,
  buildSmokeEmail,
  resolveSmokeConfig,
} from '../../scripts/smoke-sandbox.js';
import { resolveAuthSecret } from '../../src/features/identity/secret.js';

// Seam under test (ticket #14): static deployment-contract assertions plus the
// sandbox smoke-script guards. These tests pin the ADR-0008/ADR-0009/ADR-0010
// invariants that must hold before the identity service is operable in
// sandbox: isolated sandbox resources, version-controlled config without
// secrets, Cloudflare-native observability, sandbox-only mail, and an explicit
// (manual) production promotion step. They read the same version-controlled
// files the operator and CI consume; they never touch Cloudflare credentials
// or provisioned resources.

// Minimal JSONC reader for wrangler.jsonc: strips // and /* */ comments only
// outside string literals so values containing "//" survive intact.
function readJsonc(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === undefined) {
      break;
    }
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // JSONC permits trailing commas; JSON.parse does not.
  const withoutTrailingCommas = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas) as unknown;
}

interface WranglerEnv {
  vars?: Record<string, string>;
  d1_databases?: {
    binding?: string;
    database_name?: string;
    database_id?: string;
    migrations_dir?: string;
  }[];
  observability?: { enabled?: boolean };
}

interface WranglerConfig {
  vars?: Record<string, string>;
  d1_databases?: WranglerEnv['d1_databases'];
  observability?: { enabled?: boolean };
  env?: Record<string, WranglerEnv>;
}

function loadWrangler(): WranglerConfig {
  return readJsonc('wrangler.jsonc') as WranglerConfig;
}

// Returns the raw text of the top-level `on:` trigger block of a workflow,
// with `#` comments stripped so prose cannot satisfy trigger assertions.
function readTriggerBlock(path: string): string {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  expect(start, `${path} must declare a top-level "on:" trigger block`).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    if (/^\S/.test(line) && !/^\s/.test(line) && line.trim().length > 0) {
      break;
    }
    block.push(line.replace(/#.*$/, ''));
  }
  return block.join('\n');
}

describe('sandbox worker configuration (ticket #14)', () => {
  it('declares a canonical sandbox environment instead of legacy staging', () => {
    const config = loadWrangler();
    expect(Object.keys(config.env ?? {})).toContain('sandbox');
    expect(Object.keys(config.env ?? {})).not.toContain('staging');
    expect(config.env?.sandbox?.vars?.ENVIRONMENT).toBe('sandbox');
  });

  it('isolates mutable resources per environment', () => {
    const config = loadWrangler();
    const names = [
      config.d1_databases?.[0]?.database_name,
      config.env?.sandbox?.d1_databases?.[0]?.database_name,
      config.env?.production?.d1_databases?.[0]?.database_name,
    ];
    expect(names).toEqual([
      'user-service-local',
      'user-service-sandbox',
      'user-service-production',
    ]);
    const ids = [
      config.d1_databases?.[0]?.database_id,
      config.env?.sandbox?.d1_databases?.[0]?.database_id,
      config.env?.production?.d1_databases?.[0]?.database_id,
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it('points every environment at the same versioned migrations directory', () => {
    const config = loadWrangler();
    expect(config.d1_databases?.[0]?.migrations_dir).toBe('drizzle');
    expect(config.env?.sandbox?.d1_databases?.[0]?.migrations_dir).toBe('drizzle');
    expect(config.env?.production?.d1_databases?.[0]?.migrations_dir).toBe('drizzle');
  });

  it('commits no secrets in worker configuration', () => {
    const config = loadWrangler();
    const varScopes = [
      config.vars ?? {},
      ...Object.values(config.env ?? {}).map((env) => env.vars ?? {}),
    ];
    for (const vars of varScopes) {
      expect(vars).not.toHaveProperty('RESEND_API_KEY');
      expect(vars).not.toHaveProperty('BETTER_AUTH_SECRET');
    }
    const raw = readFileSync('wrangler.jsonc', 'utf8');
    expect(raw).not.toMatch(/"RESEND_API_KEY"\s*:/);
    expect(raw).not.toMatch(/"BETTER_AUTH_SECRET"\s*:/);
  });

  it('enforces the sandbox recipient allowlist in sandbox configuration', () => {
    const config = loadWrangler();
    expect(config.env?.sandbox?.vars).toHaveProperty('AUTH_MAIL_ALLOWLIST');
    expect(config.env?.production?.vars).not.toHaveProperty('AUTH_MAIL_ALLOWLIST');
  });

  it('enables the Cloudflare-native observability baseline', () => {
    const config = loadWrangler();
    expect(config.observability?.enabled).toBe(true);
  });

  it('fails closed without an explicit signing secret in sandbox', () => {
    expect(() => resolveAuthSecret({ ENVIRONMENT: 'sandbox' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(
      resolveAuthSecret({ ENVIRONMENT: 'sandbox', BETTER_AUTH_SECRET: 'sandbox-secret' }),
    ).toBe('sandbox-secret');
  });
});

describe('sandbox runbook (ticket #14)', () => {
  it('documents release, rollback, recovery, and promotion procedures', () => {
    const runbook = readFileSync('docs/operations/sandbox-release-runbook.md', 'utf8');
    for (const heading of [
      'Worker code rollback',
      'Time Travel',
      'production promotion',
      'Secret rotation',
      'smoke test',
      'Logs, traces, and metrics',
    ]) {
      expect(runbook.toLowerCase()).toContain(heading.toLowerCase());
    }
    expect(runbook).toMatch(/--env sandbox/);
    expect(runbook).toMatch(/--env production/);
  });
});

describe('deployment promotion gates (ticket #14, ADR-0008)', () => {
  it('deploys sandbox automatically from main', () => {
    const triggers = readTriggerBlock('.github/workflows/deploy-sandbox.yml');
    expect(triggers).toMatch(/push/);
    expect(triggers).toMatch(/main/);
    const workflow = readFileSync('.github/workflows/deploy-sandbox.yml', 'utf8');
    expect(workflow).toMatch(/--env sandbox/);
    expect(workflow).toMatch(/d1 migrations apply/);
  });

  it('keeps production promotion an explicit manual step', () => {
    const triggers = readTriggerBlock('.github/workflows/promote-production.yml');
    expect(triggers).toMatch(/workflow_dispatch/);
    expect(triggers).not.toMatch(/push\s*:/);
    expect(triggers).not.toMatch(/pull_request/);
    const workflow = readFileSync('.github/workflows/promote-production.yml', 'utf8');
    expect(workflow).toMatch(/--env production/);
  });
});

describe('sandbox smoke guards (ticket #14)', () => {
  it('builds unique sandbox recipients inside the allowlisted domain', () => {
    expect(buildSmokeEmail('ops.example.org', 'abc123')).toBe('smoke-abc123@ops.example.org');
  });

  it('refuses registration addresses outside the sandbox domain', () => {
    expect(() => {
      assertSandboxSmokeEmail('mallory@evil.com', 'ops.example.org');
    }).toThrow(/sandbox/i);
    expect(() => {
      assertSandboxSmokeEmail('smoke-x@ops.example.org', 'ops.example.org');
    }).not.toThrow();
  });

  it('requires explicit smoke configuration and refuses localhost by default', () => {
    expect(() =>
      resolveSmokeConfig({ SMOKE_SANDBOX_BASE_URL: '', SMOKE_SANDBOX_EMAIL_DOMAIN: '' }),
    ).toThrow(/SMOKE_SANDBOX_BASE_URL/);
    expect(() =>
      resolveSmokeConfig({
        SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
        SMOKE_SANDBOX_EMAIL_DOMAIN: '',
      }),
    ).toThrow(/SMOKE_SANDBOX_EMAIL_DOMAIN/);
    expect(() => assertSafeSmokeTarget('http://localhost:8787')).toThrow(/localhost/i);
    expect(() =>
      assertSafeSmokeTarget('http://localhost:8787', { allowLocalhost: true }),
    ).not.toThrow();
    expect(() => assertSafeSmokeTarget('https://sandbox.example.workers.dev')).not.toThrow();
  });
});
