import { readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTargetWranglerConfig } from '../../scripts/deploy/materialize.js';
import { resolveTargetDeployment, type TargetsFile } from '../../scripts/deploy/targets.js';
import { loadTargetsFromRepo, provisionedTargetsForContract } from './deploy-test-utils.js';
import {
  assertSafeSmokeTarget,
  assertSandboxSmokeEmail,
  buildSmokeEmail,
  parseExactSmokeEmail,
  resolveSmokeConfig,
  resolveSmokeEmail,
} from '../../scripts/smoke-sandbox.js';
import { resolveAuthSecret } from '../../src/features/identity/secret.js';

// Seam under test (tickets #14, #78): static deployment-contract assertions plus
// the sandbox smoke-script guards. These tests pin the ADR-0008/ADR-0009/ADR-0010
// invariants that must hold before the identity service is operable in
// sandbox: isolated per-target resources, version-controlled secret-free
// config, Cloudflare-native observability, sandbox-only mail, and an explicit
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

function loadTargets(): TargetsFile {
  return loadTargetsFromRepo();
}

// Real database ids are provisioned out-of-band and recorded in
// deploy/targets.json; contract tests resolve a provisioned copy so naming
// and isolation hold independently of provisioning state.
function provisionedTargets(): TargetsFile {
  return provisionedTargetsForContract(loadTargets());
}
// Returns the shell bodies of every `run: |` block in a workflow so
// assertions can pin shell-input hardening without constraining `with:` or
// `env:` mappings that legitimately reference workflow inputs.
function readRunBlocks(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const runMatch = /^(\s*)run:\s*\|\s*$/.exec(line);
    if (runMatch === null) {
      continue;
    }
    const baseIndent = (runMatch[1] ?? '').length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const bodyLine = lines[j] ?? '';
      if (bodyLine.trim().length === 0) {
        body.push(bodyLine);
        continue;
      }
      const indent = bodyLine.length - bodyLine.trimStart().length;
      if (indent <= baseIndent) {
        break;
      }
      body.push(bodyLine);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
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

describe('target-aware worker configuration (ticket #78)', () => {
  it('keeps wrangler.jsonc as a local base config without remote env shortcuts', () => {
    const config = loadWrangler();
    expect(config.env ?? {}).toEqual({});
    expect(config.vars?.ENVIRONMENT).toBe('local');
    expect(readFileSync('wrangler.jsonc', 'utf8')).not.toMatch(/staging/);
  });

  it('isolates mutable resources per target environment', () => {
    const config = loadWrangler();
    expect(config.d1_databases?.[0]?.database_name).toBe('user-service-local');
    const file = provisionedTargets();
    const sandbox = resolveTargetDeployment(file, {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    const production = resolveTargetDeployment(file, {
      target: 'rch-rugbychampagne',
      environment: 'production',
    });
    expect(sandbox.workerName).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(production.workerName).toBe('rch-rugbychampagne-user-service-production');
    expect(sandbox.databaseName).toBe('rch-rugbychampagne-user-service-sandbox-db');
    expect(production.databaseName).toBe('rch-rugbychampagne-user-service-production-db');
    expect(sandbox.databaseId).not.toBe(production.databaseId);
  });

  it('keeps the stable DB binding on materialized target configs', () => {
    const file = provisionedTargets();
    for (const environment of ['sandbox', 'production'] as const) {
      const resolved = resolveTargetDeployment(file, {
        target: 'rch-rugbychampagne',
        environment,
      });
      const materialized = buildTargetWranglerConfig(resolved);
      expect(materialized.d1_databases).toHaveLength(1);
      expect(materialized.d1_databases[0].binding).toBe('DB');
      // Ticket #85: temp configs carry the absolute repository drizzle path
      // (Wrangler resolves relative entries from the temp config location).
      const migrationsDir = materialized.d1_databases[0].migrations_dir;
      expect(isAbsolute(migrationsDir)).toBe(true);
      expect(basename(migrationsDir)).toBe('drizzle');
      expect(isAbsolute(materialized.main)).toBe(true);
    }
  });

  it('points every environment at the same versioned migrations directory', () => {
    const config = loadWrangler();
    expect(config.d1_databases?.[0]?.migrations_dir).toBe('drizzle');
  });

  it('commits no secrets in worker or target configuration', () => {
    const config = loadWrangler();
    expect(config.vars ?? {}).not.toHaveProperty('RESEND_API_KEY');
    expect(config.vars ?? {}).not.toHaveProperty('BETTER_AUTH_SECRET');
    const raw = readFileSync('wrangler.jsonc', 'utf8');
    expect(raw).not.toMatch(/"RESEND_API_KEY"\s*:/);
    expect(raw).not.toMatch(/"BETTER_AUTH_SECRET"\s*:/);
    const targetsRaw = readFileSync('deploy/targets.json', 'utf8');
    for (const secret of [
      'BETTER_AUTH_SECRET',
      'RESEND_API_KEY',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'CLOUDFLARE_API_TOKEN',
    ]) {
      expect(targetsRaw).not.toMatch(new RegExp(`"${secret}"\\s*:`));
    }
  });

  it('enforces the sandbox recipient allowlist in target configuration', () => {
    // Ticket #88: RCH sandbox mail no longer depends on ingalatech.com; the
    // allowlist holds only the Gmail acceptance recipient.
    const file = loadTargets();
    const sandbox = file.targets.find((entry) => entry.key === 'rch-rugbychampagne');
    expect(sandbox?.environments.sandbox.vars.AUTH_MAIL_TRANSPORT).toBe('smtp');
    expect(sandbox?.environments.sandbox.vars.AUTH_MAIL_ALLOWLIST).toBe('jonatangarbuyo@gmail.com');
    expect(sandbox?.environments.sandbox.vars.AUTH_MAIL_FROM).toBe(
      'User Service <jonatangarbuyo@gmail.com>',
    );
    expect(JSON.stringify(sandbox?.environments.sandbox.vars)).not.toContain('ingalatech.com');
    expect(sandbox?.environments.production.vars.AUTH_MAIL_ALLOWLIST ?? '').toBe('');
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

describe('sandbox runbook (ticket #14, #78)', () => {
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
  });

  it('documents the target-aware deploy boundary and first-target provisioning', () => {
    const runbook = readFileSync('docs/operations/sandbox-release-runbook.md', 'utf8');
    expect(runbook).toMatch(/npm run deploy/);
    expect(runbook).toMatch(/rch-rugbychampagne-user-service-sandbox/);
    expect(runbook).toMatch(/deploy\/targets\.json/);
    expect(runbook).toMatch(/--write-config/);
    expect(runbook).toMatch(/secret put/);
  });
});

describe('deployment promotion gates (ticket #14, #78, ADR-0008)', () => {
  it('deploys the configured sandbox target automatically from main', () => {
    const triggers = readTriggerBlock('.github/workflows/deploy-sandbox.yml');
    expect(triggers).toMatch(/push/);
    expect(triggers).toMatch(/main/);
    const workflow = readFileSync('.github/workflows/deploy-sandbox.yml', 'utf8');
    expect(workflow).toMatch(/npm run deploy/);
    expect(workflow).toMatch(/--target rch-rugbychampagne/);
    expect(workflow).toMatch(/--env sandbox/);
    expect(workflow).toMatch(/--non-interactive/);
  });

  it('keeps resource naming in the deploy boundary instead of the workflow', () => {
    const workflow = readFileSync('.github/workflows/deploy-sandbox.yml', 'utf8');
    expect(workflow).not.toMatch(/wrangler d1 migrations apply/);
    expect(workflow).not.toMatch(/wrangler deploy /);
    expect(workflow).not.toMatch(/wrangler deployments list/);
  });

  it('keeps production promotion an explicit manual step', () => {
    const triggers = readTriggerBlock('.github/workflows/promote-production.yml');
    expect(triggers).toMatch(/workflow_dispatch/);
    expect(triggers).not.toMatch(/push\s*:/);
    expect(triggers).not.toMatch(/pull_request/);
    const workflow = readFileSync('.github/workflows/promote-production.yml', 'utf8');
    expect(workflow).toMatch(/npm run deploy:production/);
    expect(workflow).toMatch(/--confirm/);
  });

  it('routes workflow_dispatch inputs through env in shell run blocks', () => {
    const path = '.github/workflows/promote-production.yml';
    const workflow = readFileSync(path, 'utf8');
    const runBlocks = readRunBlocks(path);
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) {
      expect(block).not.toMatch(/\$\{\{\s*inputs\./);
    }
    expect(workflow).toMatch(/TARGET:\s*\$\{\{\s*inputs\.target\s*\}\}/);
    expect(workflow).toMatch(/CONFIRM_PRODUCTION:\s*\$\{\{\s*inputs\.confirm_production\s*\}\}/);
    expect(workflow).toMatch(/SOURCE_COMMIT:\s*\$\{\{\s*inputs\.source_commit\s*\}\}/);
    expect(workflow).toMatch(/\$TARGET/);
    expect(workflow).toMatch(/\$CONFIRM_PRODUCTION/);
    expect(workflow).toMatch(/\$SOURCE_COMMIT/);
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

  it('prefers the exact allowlisted recipient without requiring an email domain', () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL: 'Smoke-Contact@ops.example.org',
    });
    expect(config.recipient).toEqual({ kind: 'exact', email: 'smoke-contact@ops.example.org' });
  });

  it('rejects a syntactically invalid exact recipient instead of falling back', () => {
    for (const bad of ['not-an-email', 'smoke@', '@ops.example.org', 'smoke@ops', '']) {
      expect(() => parseExactSmokeEmail(bad)).toThrow(/SMOKE_SANDBOX_EMAIL/);
    }
    for (const bad of ['not-an-email', 'smoke@', '@ops.example.org', 'smoke@ops']) {
      expect(() =>
        resolveSmokeConfig({
          SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
          SMOKE_SANDBOX_EMAIL: bad,
          SMOKE_SANDBOX_EMAIL_DOMAIN: 'ops.example.org',
        }),
      ).toThrow(/SMOKE_SANDBOX_EMAIL/);
    }
  });

  it('treats an empty exact recipient as unset and keeps domain mode', () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL: '',
      SMOKE_SANDBOX_EMAIL_DOMAIN: 'ops.example.org',
    });
    expect(config.recipient).toEqual({ kind: 'domain', emailDomain: 'ops.example.org' });
  });

  it('normalizes a valid exact recipient without logging it', () => {
    expect(parseExactSmokeEmail('  Smoke-Contact@Ops.Example.Org  ')).toBe(
      'smoke-contact@ops.example.org',
    );
  });

  it('never generates or infers a recipient in exact mode', () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL: 'smoke-contact@ops.example.org',
    });
    expect(resolveSmokeEmail(config, 'abc123')).toBe('smoke-contact@ops.example.org');
    expect(resolveSmokeEmail(config, 'zzz999')).toBe('smoke-contact@ops.example.org');
  });

  it('keeps domain-generated mode when no exact recipient is configured', () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL_DOMAIN: 'ops.example.org',
    });
    expect(config.recipient).toEqual({ kind: 'domain', emailDomain: 'ops.example.org' });
    expect(resolveSmokeEmail(config, 'abc123')).toBe('smoke-abc123@ops.example.org');
  });

  it('still fails closed when neither recipient mode is configured', () => {
    expect(() =>
      resolveSmokeConfig({
        SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      }),
    ).toThrow(/SMOKE_SANDBOX_EMAIL/);
  });

  it('never logs the explicit recipient, password, or token', () => {
    const source = readFileSync('scripts/smoke-sandbox.ts', 'utf8');
    const logLines = source.split('\n').filter((line) => {
      const text = line.trim();
      if (text.startsWith('//')) {
        return false;
      }
      return text.includes('logStep(') || text.includes('console.log(') || text.includes('fail(');
    });
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      const code = line
        .replace(/'[^']*'/g, '')
        .replace(/"[^"]*"/g, '')
        .replace(/`[^`]*`/g, '');
      expect(code).not.toMatch(/\bemail\b/i);
      expect(code).not.toMatch(/\bpassword\b/i);
      expect(code).not.toMatch(/\btoken\b/i);
    }
  });

  it('wires the exact-recipient secret through env without exposing it in run blocks', () => {
    const workflow = readFileSync('.github/workflows/deploy-sandbox.yml', 'utf8');
    expect(workflow).toMatch(/SMOKE_SANDBOX_EMAIL:\s*\$\{\{\s*secrets\.SANDBOX_SMOKE_EMAIL\s*\}\}/);
    for (const block of readRunBlocks('.github/workflows/deploy-sandbox.yml')) {
      expect(block).not.toMatch(/SANDBOX_SMOKE_EMAIL/);
      expect(block).not.toMatch(/SMOKE_SANDBOX_EMAIL/);
    }
  });

  it('documents exact-recipient sandbox acceptance in the runbook', () => {
    const runbook = readFileSync('docs/operations/sandbox-release-runbook.md', 'utf8');
    expect(runbook).toMatch(/SANDBOX_SMOKE_EMAIL(?!_DOMAIN)/);
    expect(runbook).toMatch(/SMOKE_SANDBOX_EMAIL(?!_DOMAIN)/);
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
