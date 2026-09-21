import { describe, expect, it } from 'vitest';
import {
  buildSessionFailureTailArgs,
  formatSafeSessionFailure,
  parseTailLine,
  parseTailLines,
  SESSION_FAILURE_TAIL_MAX_DURATION_MS,
  SESSION_FAILURE_TAIL_START_TIMEOUT_MS,
  SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS,
  summarizeSessionFailures,
  withTimeout,
} from '../../scripts/deploy/diagnostic-tail.js';
import {
  planDeploymentSteps,
  runDeployment,
  type DeployCommandRunner,
  type DeployIo,
} from '../../scripts/deploy/orchestrate.js';
import type { ResolvedDeployment } from '../../scripts/deploy/targets.js';
import { CONTRACT_SANDBOX_DATABASE_ID } from './deploy-test-utils.js';

// Seams under test (ticket #96, ADR-0009):
// 1. `scripts/deploy/diagnostic-tail.ts` — pure whitelist boundary for the
//    already-redacted `session.resolve-failed` Worker event. Only `event`,
//    `phase`, and optional `requestId`/`environment` correlation may surface;
//    exception text, cookies, credentials, tokens, emails, URLs and bodies
//    never surface.
// 2. `scripts/deploy/orchestrate.ts` — sandbox deploy boundary starts a
//    bounded diagnostic tail immediately before `smoke-sandbox` and always
//    terminates it afterward. A failed smoke reports the safe phase
//    (`config`|`auth`|`session`) or `phase unavailable`; a successful smoke
//    never fails for missing events; production never tails.

const SANDBOX: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: CONTRACT_SANDBOX_DATABASE_ID,
  vars: { AUTH_MAIL_TRANSPORT: 'smtp' },
};

const DIRECT = JSON.stringify({
  level: 'error',
  event: 'session.resolve-failed',
  phase: 'config',
  requestId: 'req-123',
  environment: 'sandbox',
});

function envelopeWith(message: string): string {
  return JSON.stringify({
    outcome: 'ok',
    scriptName: 'rch-rugbychampagne-user-service-sandbox',
    exceptions: [],
    logs: [{ message: [message], level: 'log', timestamp: 1758500000000 }],
    eventTimestamp: 1758500000000,
    event: { request: { url: 'https://sandbox.workers.dev/v1/me', method: 'GET' } },
  });
}

describe('session failure tail args (ticket #96)', () => {
  it('tails the sandbox Worker filtered to the safe event with the target config', () => {
    const args = buildSessionFailureTailArgs(SANDBOX, '/tmp/wrangler.sandbox.json');
    expect(args).toEqual([
      'wrangler',
      'tail',
      'rch-rugbychampagne-user-service-sandbox',
      '--format',
      'json',
      '--search',
      'session.resolve-failed',
      '--config',
      '/tmp/wrangler.sandbox.json',
    ]);
  });

  it('never embeds secrets or email addresses in the tail invocation', () => {
    const args = buildSessionFailureTailArgs(SANDBOX, '/tmp/wrangler.sandbox.json');
    const text = args.join(' ');
    expect(text).not.toMatch(/SECRET/i);
    expect(text).not.toMatch(/SMTP/i);
    expect(text).not.toMatch(/@/);
  });
});

describe('session failure whitelist parsing (ticket #96, ADR-0009)', () => {
  it('parses the direct redacted Worker event', () => {
    expect(parseTailLine(DIRECT)).toEqual({
      event: 'session.resolve-failed',
      phase: 'config',
      requestId: 'req-123',
      environment: 'sandbox',
    });
  });

  it('extracts the safe event from a wrangler tail JSON envelope', () => {
    const inner = JSON.stringify({ event: 'session.resolve-failed', phase: 'auth' });
    expect(parseTailLine(envelopeWith(inner))).toEqual({
      event: 'session.resolve-failed',
      phase: 'auth',
    });
  });

  it('supports every stable phase without leaking extra fields', () => {
    for (const phase of ['config', 'auth', 'session'] as const) {
      const parsed = parseTailLine(
        JSON.stringify({ level: 'error', event: 'session.resolve-failed', phase }),
      );
      expect(parsed).toEqual({ event: 'session.resolve-failed', phase });
    }
    const withSecrets = parseTailLine(
      JSON.stringify({
        level: 'error',
        event: 'session.resolve-failed',
        phase: 'session',
        requestId: 'req-9',
        environment: 'sandbox',
        message: 'boom: connection refused',
        stack: 'Error: boom',
        email: 'probe@ops.example.org',
        token: 'secret-token',
        cookie: 'better-auth.session_token=abc',
        url: 'https://example.com/?token=abc',
      }),
    );
    expect(withSecrets).toEqual({
      event: 'session.resolve-failed',
      phase: 'session',
      requestId: 'req-9',
      environment: 'sandbox',
    });
  });

  it('rejects non-matching events, unknown phases, and non-JSON lines', () => {
    expect(
      parseTailLine(JSON.stringify({ level: 'info', event: 'smoke', status: 200 })),
    ).toBeNull();
    expect(
      parseTailLine(JSON.stringify({ event: 'session.resolve-failed', phase: 'mailer' })),
    ).toBeNull();
    expect(parseTailLine('not json at all')).toBeNull();
    expect(parseTailLine('')).toBeNull();
    expect(parseTailLine(JSON.stringify({ outcome: 'ok', logs: [], exceptions: [] }))).toBeNull();
  });

  it('collects only the safe events from a tail window', () => {
    const lines = [
      DIRECT,
      JSON.stringify({ level: 'info', step: 'health', status: 200 }),
      envelopeWith(JSON.stringify({ event: 'session.resolve-failed', phase: 'session' })),
      'garbage line',
    ];
    const events = parseTailLines(lines);
    expect(events.map((entry) => entry.phase)).toEqual(['config', 'session']);
  });
});

describe('session failure summary redaction (ticket #96, ADR-0009)', () => {
  it('reports the observed phase without raw log text', () => {
    const summary = summarizeSessionFailures([{ event: 'session.resolve-failed', phase: 'auth' }]);
    expect(summary).toMatch(/auth/);
    expect(summary).not.toMatch(/boom|token|cookie|@/i);
  });

  it('reports phase unavailable when no safe event was observed', () => {
    const summary = summarizeSessionFailures([]);
    expect(summary).toMatch(/phase unavailable/i);
  });

  it('formats only whitelisted fields', () => {
    const formatted = formatSafeSessionFailure({
      event: 'session.resolve-failed',
      phase: 'session',
      requestId: 'req-7',
      environment: 'sandbox',
    });
    expect(JSON.parse(formatted)).toEqual({
      event: 'session.resolve-failed',
      phase: 'session',
      requestId: 'req-7',
      environment: 'sandbox',
    });
  });
});

describe('session failure tail bounds (ticket #96)', () => {
  it('declares finite start/stop/maximum timeouts', () => {
    for (const bound of [
      SESSION_FAILURE_TAIL_START_TIMEOUT_MS,
      SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS,
      SESSION_FAILURE_TAIL_MAX_DURATION_MS,
    ]) {
      expect(Number.isFinite(bound)).toBe(true);
      expect(bound).toBeGreaterThan(0);
    }
    expect(SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS).toBeLessThan(SESSION_FAILURE_TAIL_MAX_DURATION_MS);
  });

  it('resolves when the wrapped promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'tail stop')).resolves.toBe('ok');
  });

  it('rejects instead of hanging when the wrapped promise never settles', async () => {
    await expect(withTimeout(new Promise<never>(() => undefined), 20, 'tail stop')).rejects.toThrow(
      /tail stop.*timed out/,
    );
  });
});

describe('sandbox smoke diagnostic tail lifecycle (ticket #96)', () => {
  interface TailHarness {
    io: DeployIo;
    runner: DeployCommandRunner;
    logs: string[];
    started: number;
    stopped: number;
    tailLines: string[];
    startFails: boolean;
  }

  function createTailHarness(options: {
    smokeFails?: boolean;
    tailLines?: string[];
    startFails?: boolean;
  }): TailHarness {
    const harness: TailHarness = {
      io: undefined as unknown as DeployIo,
      runner: (command, args) => {
        if (command === 'npm' && args.join(' ').includes('smoke:sandbox')) {
          if (options.smokeFails === true) {
            return Promise.resolve({ exitCode: 1 });
          }
          return Promise.resolve({ exitCode: 0 });
        }
        return Promise.resolve({ exitCode: 0 });
      },
      logs: [],
      started: 0,
      stopped: 0,
      tailLines: options.tailLines ?? [],
      startFails: options.startFails ?? false,
    };
    harness.io = {
      materialize: () => '/tmp/wrangler.tail-test.json',
      cleanup: () => undefined,
      preflight: () => Promise.resolve(undefined),
      log: (message) => {
        harness.logs.push(message);
      },
      startSessionFailureTail: () => {
        harness.started += 1;
        if (harness.startFails) {
          return Promise.reject(new Error('tail unavailable'));
        }
        return Promise.resolve({
          stop: () => {
            harness.stopped += 1;
            return Promise.resolve([...harness.tailLines]);
          },
        });
      },
    };
    return harness;
  }

  it('keeps sandbox smoke as the last planned step', () => {
    expect(planDeploymentSteps({ resolved: SANDBOX }).at(-1)).toBe('smoke-sandbox');
  });

  it('starts the tail before smoke and always terminates it on failure', async () => {
    const harness = createTailHarness({
      smokeFails: true,
      tailLines: [JSON.stringify({ event: 'session.resolve-failed', phase: 'session' })],
    });
    await expect(runDeployment({ resolved: SANDBOX }, harness.io, harness.runner)).rejects.toThrow(
      /smoke-sandbox/,
    );
    expect(harness.started).toBe(1);
    expect(harness.stopped).toBe(1);
    expect(harness.logs.join('\n')).toMatch(/session/);
  });

  it('reports phase unavailable instead of dumping unfiltered logs when smoke fails with no event', async () => {
    const harness = createTailHarness({ smokeFails: true, tailLines: [] });
    await expect(runDeployment({ resolved: SANDBOX }, harness.io, harness.runner)).rejects.toThrow(
      /smoke-sandbox/,
    );
    expect(harness.stopped).toBe(1);
    const transcript = harness.logs.join('\n');
    expect(transcript).toMatch(/phase unavailable/i);
  });

  it('does not fail a successful smoke when no diagnostic event was observed', async () => {
    const harness = createTailHarness({ smokeFails: false, tailLines: [] });
    await expect(
      runDeployment({ resolved: SANDBOX }, harness.io, harness.runner),
    ).resolves.toMatchObject({ workerName: SANDBOX.workerName });
    expect(harness.started).toBe(1);
    expect(harness.stopped).toBe(1);
  });

  it('still runs smoke when tail startup fails', async () => {
    const harness = createTailHarness({ smokeFails: false, startFails: true });
    await expect(
      runDeployment({ resolved: SANDBOX }, harness.io, harness.runner),
    ).resolves.toMatchObject({ workerName: SANDBOX.workerName });
    expect(harness.started).toBe(1);
    expect(harness.stopped).toBe(0);
  });

  it('never starts a diagnostic tail for production', async () => {
    const harness = createTailHarness({ smokeFails: false });
    const production: ResolvedDeployment = {
      ...SANDBOX,
      environment: 'production',
      workerName: 'rch-rugbychampagne-user-service-production',
      databaseName: 'rch-rugbychampagne-user-service-production-db',
    };
    await runDeployment(
      { resolved: production, confirm: production.workerName },
      harness.io,
      harness.runner,
    );
    expect(harness.started).toBe(0);
    expect(harness.stopped).toBe(0);
  });
});
