import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEvidenceInvocation,
  createEvidenceCapture,
  finalizeSkillEvidence,
  MAX_CAPTURED_LINES,
  suppressJsonWorkerLines,
} from '../../scripts/review/evidence-worker.js';
import {
  captureImplementationRecovery,
  summarizeWorkerErrors,
  summarizeWorkerLifecycle,
} from '../../scripts/review/implementation-recovery.js';
import { runFixCycleCorrection } from '../../scripts/agent/fix-cycle-correction.js';
import { evidenceStreamingWorkerExecutor } from '../../scripts/review/evidence-streaming-executor.js';
import { runWorkerStream, type SpawnedWorker } from '../../scripts/review/worker-stream.js';
import {
  isWorkerTimeout,
  WorkerTimeoutError,
  type WorkerLabel,
} from '../../scripts/review/worker-timeout.js';
import { createRunSummaryRecorder } from '../../scripts/review/run-summary.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';

// Seam under test (ticket #138): bounded structured worker error diagnostics.
// Independent fixtures use literal protocol-shaped envelopes from the pinned
// OpenCode 1.18.30 sources (parent #137), never implementation snapshots,
// source strings, raw transcripts or real provider credentials.
function apiErrorLine(status: number, retryable: boolean): string {
  return JSON.stringify({
    type: 'error',
    timestamp: 1700000000000,
    error: { name: 'APIError', data: { statusCode: status, isRetryable: retryable } },
    message: 'sentinel-message-must-not-persist-sk-ant-401',
    headers: { authorization: 'ghp_sentinel-header' },
    body: 'sentinel-body',
  });
}

function namedErrorLine(name: string): string {
  return JSON.stringify({
    type: 'error',
    timestamp: 1700000000000,
    error: { name, data: {} },
  });
}

async function finalizeToMemory(lines: readonly string[]) {
  const written = new Map<string, string>();
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const result = await finalizeSkillEvidence(
      {
        invocation: buildEvidenceInvocation({
          worker: 'review-cycle',
          command: 'review-standards',
          axis: 'standards',
          attempt: 1,
          workerStartHead: 'a'.repeat(40),
          env: {},
        }),
        lines,
      },
      {
        dir: '.test-evidence',
        mkdir: () => Promise.resolve(),
        writeFile: (path: string, contents: string) => {
          written.set(path, contents);
          return Promise.resolve();
        },
      },
    );
    const persisted = JSON.parse(
      written.get(result.evidencePath ?? '.test-evidence/missing') ?? '{}',
    ) as Record<string, unknown>;
    const logged = [
      ...logSpy.mock.calls.map((call) => String(call[0])),
      ...errorSpy.mock.calls.map((call) => String(call[0])),
    ].join('\n');
    return { result, persisted, written, logged };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe('shared safe error projection', () => {
  it('distinguishes APIError 401 from 429 with validated status and retryability', () => {
    const line401 = apiErrorLine(401, false);
    const line429 = apiErrorLine(429, true);

    const summary401 = summarizeWorkerLifecycle([line401]);
    const summary429 = summarizeWorkerLifecycle([line429]);

    expect(summary401.eventCounts).toMatchObject({ error: 1 });
    expect(summary429.eventCounts).toMatchObject({ error: 1 });
    // Existing lifecycle meanings are preserved: same timestamps/duration.
    expect(summary401.firstTimestamp).toBe(summary429.firstTimestamp);
    expect(summary401.durationMs).toBe(0);
    expect(summary401.status).toBe('complete');

    expect(summary401.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
      apiStatusCounts: { '401': 1 },
      apiRetryableTrue: 0,
      apiRetryableFalse: 1,
      apiRetryableUnknown: 0,
    });
    expect(summary429.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
      apiStatusCounts: { '429': 1 },
      apiRetryableTrue: 1,
      apiRetryableFalse: 0,
      apiRetryableUnknown: 0,
    });
    expect(JSON.stringify(summary401.errors)).not.toBe(JSON.stringify(summary429.errors));
    // Shared projection agrees with the standalone summarizer.
    expect(summary401.errors).toEqual(summarizeWorkerErrors([line401]));
    expect(summary429.errors).toEqual(summarizeWorkerErrors([line429]));
  });

  it('retains every permitted error name in one shared bucket scheme', () => {
    const names = [
      'APIError',
      'ProviderAuthError',
      'MessageOutputLengthError',
      'MessageAbortedError',
      'StructuredOutputError',
      'ContextOverflowError',
      'ContentFilterError',
      'UnknownError',
    ];
    const lines = names.map((name) =>
      JSON.stringify({ type: 'error', timestamp: 1700000000000, error: { name } }),
    );
    const summary = summarizeWorkerErrors(lines);

    expect(summary.total).toBe(names.length);
    for (const name of names) {
      expect(summary.byName[name as keyof typeof summary.byName]).toBe(1);
    }
    // Only one APIError record exists, and it lacks data so retryability is unknown.
    expect(summary.apiStatusCounts).toEqual({});
    expect(summary.apiRetryableUnknown).toBe(1);
  });

  it('keeps missing and unsupported names in a fixed unknown bucket', () => {
    const lines = [
      JSON.stringify({ type: 'error', timestamp: 1700000000000 }),
      JSON.stringify({ type: 'error', timestamp: 1700000000000, error: null }),
      JSON.stringify({ type: 'error', timestamp: 1700000000000, error: { name: 'CustomBoom' } }),
      JSON.stringify({ type: 'error', timestamp: 1700000000000, error: { name: '' } }),
      JSON.stringify({ type: 'error', timestamp: 1700000000000, error: { name: 42 } }),
      JSON.stringify({ type: 'error', timestamp: 1700000000000, error: { name: ' APIError ' } }),
      'not-json',
      JSON.stringify({ type: 'text', part: { text: 'hi' } }),
    ];
    const summary = summarizeWorkerErrors(lines);

    // Six top-level error events collapse to the fixed bucket; non-error and
    // malformed lines never become error counts or arbitrary keys.
    expect(summary.total).toBe(6);
    expect(summary.byName).toEqual({ unknown: 6 });
    expect(Object.keys(summary.byName)).toEqual(['unknown']);
    expect(JSON.stringify(summary)).not.toContain('CustomBoom');
  });

  it('rejects coerced status and retryability without copying payloads', () => {
    const lines = [
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'APIError', data: { statusCode: '401', isRetryable: 'true' } },
      }),
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'APIError', data: { statusCode: 401.5, isRetryable: 1 } },
      }),
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'APIError', data: { statusCode: 99, isRetryable: null } },
      }),
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'APIError', data: { statusCode: 600, isRetryable: {} } },
      }),
      // Independently supplied overflowing exponent: JSON.parse('1e309')
      // yields Infinity (JSON.stringify(Number.NaN) would emit null and never
      // exercise parsed non-finite input).
      '{"type":"error","timestamp":1700000000000,"error":{"name":"APIError","data":{"statusCode":1e309},"cause":{"nested":{"statusCode":500,"secret":"sk-ant-nested"}}}}',
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'APIError', data: { statusCode: null } },
      }),
    ];
    const summary = summarizeWorkerErrors(lines);

    expect(summary.total).toBe(6);
    expect(summary.byName).toEqual({ APIError: 6 });
    expect(summary.apiStatusCounts).toEqual({});
    expect(summary.apiRetryableTrue).toBe(0);
    expect(summary.apiRetryableFalse).toBe(0);
    expect(summary.apiRetryableUnknown).toBe(6);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('401');
    expect(serialized).not.toContain('sk-ant-nested');
  });

  it('retains boundary statuses 100 and 599 and discards non-APIError status', () => {
    const lines = [
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'APIError', data: { statusCode: 100, isRetryable: true } },
      }),
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'APIError', data: { statusCode: 599, isRetryable: false } },
      }),
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'ProviderAuthError', data: { statusCode: 401, isRetryable: true } },
      }),
    ];
    const summary = summarizeWorkerErrors(lines);

    expect(summary.total).toBe(3);
    expect(summary.apiStatusCounts).toEqual({ '100': 1, '599': 1 });
    expect(summary.apiRetryableTrue).toBe(1);
    expect(summary.apiRetryableFalse).toBe(1);
    expect(summary.apiRetryableUnknown).toBe(0);
  });

  it('never persists sentinels from discarded error and tool fields', async () => {
    // Pinned APIError sensitive data is nested under error.data (message,
    // responseHeaders, responseBody, metadata); sentinels live in those real
    // fields plus outer event/error and unknown-name/cause variants.
    const lines = [
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: {
          name: 'APIError',
          data: {
            statusCode: 401,
            isRetryable: false,
            message: 'sk-ant-data-message-must-not-persist',
            responseHeaders: { authorization: 'ghp_data-header-sentinel' },
            responseBody: 'sk-ant-data-body-sentinel',
            metadata: { token: 'github_pat_data-metadata-sentinel' },
          },
          message: 'sk-ant-secret-message',
          stack: 'stack ghp_secret-stack',
          headers: { authorization: 'Bearer sk-ant-header' },
          providerId: 'OPENCODE_ZEN_API_KEY sentinel',
          metadata: { token: 'github_pat_sentinel' },
          cause: { privateKey: '-----BEGIN PRIVATE KEY----- sentinel' },
        },
        prompt: 'private@example.test prompt',
        reasoning: 'reasoning sentinel',
        toolInput: { command: 'rm -rf /' },
        toolOutput: 'output sentinel',
        command: 'opencode run --secret',
        recipient: 'someone@example.test',
      }),
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: {
          name: 'CustomBoom',
          data: {
            statusCode: 500,
            isRetryable: true,
            message: 'sk-ant-unknown-data-message',
            responseBody: 'sk-ant-unknown-data-body',
            metadata: { sessionToken: 'ghp_unknown-data-sentinel' },
          },
          cause: { secret: 'sk-ant-unknown-cause-sentinel' },
        },
      }),
    ];
    const { result, persisted, logged } = await finalizeToMemory(lines);

    expect(result.record.lifecycle?.errors).toMatchObject({
      total: 2,
      byName: { APIError: 1, unknown: 1 },
    });
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toMatch(
      /sk-ant-|ghp_|github_pat_|OPENCODE_ZEN_API_KEY|BEGIN PRIVATE KEY|private@example\.test|rm -rf/,
    );
    expect(logged).not.toMatch(/sk-ant-|ghp_|github_pat_|OPENCODE_ZEN_API_KEY|BEGIN PRIVATE KEY/);
  });

  it('discloses mixed, split-line and truncated capture without changing field meanings', async () => {
    const complete = apiErrorLine(401, false);
    const mixed = [
      complete,
      JSON.stringify({ type: 'step_start', timestamp: 1700000000000 }),
      'split-fragment-without-newline-closing',
      JSON.stringify({ type: 'mystery-event' }),
    ];
    const { result } = await finalizeToMemory(mixed);

    expect(result.record.lifecycle?.eventCounts).toMatchObject({ error: 1, step_start: 1 });
    expect(result.record.lifecycle?.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
    });
    expect(result.record.lifecycle?.malformed).toBe(1);
    expect(result.record.lifecycle?.unknownEvents).toBe(1);
    expect(result.record.lifecycle?.status).toBe('incomplete');
    expect(JSON.stringify(result.record.lifecycle)).not.toContain('split-fragment');
    expect(JSON.stringify(result.record.lifecycle)).not.toContain('mystery-event');
  });

  it('assembles a valid error envelope from split worker-stream chunks into persisted errors', async () => {
    const envelope = JSON.stringify({
      type: 'error',
      timestamp: 1700000000000,
      error: { name: 'APIError', data: { statusCode: 429, isRetryable: true } },
    });
    const splitAt = Math.floor(envelope.length / 2);
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as SpawnedWorker;
    child.stdout = stdout;
    child.stderr = stderr;
    const capture = createEvidenceCapture();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'split-fixture', stdoutLogFilter: suppressJsonWorkerLines },
        () => child,
        {
          onStdoutLine: (line) => {
            capture.pushLine(line);
          },
        },
      );
      stdout.emit('data', envelope.slice(0, splitAt));
      stdout.emit('data', `${envelope.slice(splitAt)}\n`);
      child.emit('close', 0);
      await pending;
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(capture.lines).toEqual([envelope]);
    expect(capture.wasTruncated()).toBe(false);

    const { result, persisted } = await finalizeToMemory(capture.lines);
    expect(result.record.lifecycle?.capturedLineCount).toBe(1);
    expect(result.record.lifecycle?.captureTruncated).toBe(false);
    expect(result.record.lifecycle?.status).toBe('complete');
    expect(result.record.lifecycle?.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
      apiStatusCounts: { '429': 1 },
      apiRetryableTrue: 1,
      apiRetryableFalse: 0,
      apiRetryableUnknown: 0,
    });
    expect(JSON.stringify(persisted)).toContain('"429"');
  });

  it('retains only the captured prefix when the stream exceeds the configured bound', async () => {
    const retained = JSON.stringify({
      type: 'error',
      timestamp: 1700000000000,
      error: { name: 'APIError', data: { statusCode: 401, isRetryable: false } },
    });
    const beyond = JSON.stringify({
      type: 'error',
      timestamp: 1700000000000,
      error: { name: 'APIError', data: { statusCode: 429, isRetryable: true } },
    });
    const capture = createEvidenceCapture();
    for (let index = 0; index < MAX_CAPTURED_LINES; index += 1) {
      capture.pushLine(retained);
    }
    for (let index = 0; index < 3; index += 1) {
      capture.pushLine(beyond);
    }

    expect(capture.lines).toHaveLength(MAX_CAPTURED_LINES);
    expect(capture.wasTruncated()).toBe(true);

    const written = new Map<string, string>();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'review-cycle',
            command: 'review-standards',
            axis: 'standards',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines: capture.lines,
          truncatedStream: capture.wasTruncated(),
        },
        {
          dir: '.test-evidence',
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );
      expect(result.record.lifecycle?.capturedLineCount).toBe(MAX_CAPTURED_LINES);
      expect(result.record.lifecycle?.captureTruncated).toBe(true);
      expect(result.record.lifecycle?.status).toBe('incomplete');
      expect(result.record.lifecycle?.reasons.join(' ')).toMatch(/truncated/);
      expect(result.record.lifecycle?.errors?.total).toBe(MAX_CAPTURED_LINES);
      expect(result.record.lifecycle?.errors?.apiStatusCounts).toEqual({
        '401': MAX_CAPTURED_LINES,
      });
      expect(result.record.lifecycle?.errors?.apiRetryableFalse).toBe(MAX_CAPTURED_LINES);
      const persisted = JSON.parse(
        written.get(result.evidencePath ?? '.test-evidence/missing') ?? '{}',
      ) as { lifecycle?: { errors?: { apiStatusCounts?: Record<string, number> } } };
      expect(persisted.lifecycle?.errors?.apiStatusCounts).toEqual({
        '401': MAX_CAPTURED_LINES,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it('shares identical error semantics between recovery and finalized evidence', async () => {
    const lines = [apiErrorLine(401, false), namedErrorLine('ContextOverflowError')];
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const execute: CommandExecutor = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'git rev-parse HEAD') {
        return Promise.resolve({ stdout: `${head}\n`, stderr: '' });
      }
      if (key === 'git rev-parse --abbrev-ref HEAD') {
        return Promise.resolve({ stdout: 'ticket/138-x\n', stderr: '' });
      }
      if (key === `git diff --name-only --no-renames ${base}..${head} --`) {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (key === 'git status --porcelain -uall') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
    const recovery = await captureImplementationRecovery(
      { base, branch: 'ticket/138-x', lines },
      { execute },
    );
    const { result } = await finalizeToMemory(lines);

    expect(recovery.diagnostics.errors).toEqual(result.record.lifecycle?.errors);
    expect(recovery.diagnostics.errors).toMatchObject({
      total: 2,
      byName: { APIError: 1, ContextOverflowError: 1 },
    });
    expect(recovery.diagnostics.eventCounts).toMatchObject({ error: 2 });
  });

  it('persists the additive summary on fix-cycle call sites without masking outcomes', async () => {
    const progress = JSON.stringify({
      type: 'error',
      timestamp: 1700000000000,
      error: { name: 'APIError', data: { statusCode: 429, isRetryable: true } },
    });
    const written = new Map<string, string>();
    const sentinels = new Map<string, string>();
    const realFinalizer = async (input: {
      worker: 'agent-fix-cycle';
      command: string;
      axis: string;
      attempt: number;
      workerStartHead: string;
      lines: readonly string[];
      truncatedStream?: boolean;
    }): Promise<string | undefined> => {
      const { finalizeSkillEvidence: finalize, buildEvidenceInvocation: buildInvocation } =
        await import('../../scripts/review/evidence-worker.js');
      const settled = await finalize(
        {
          invocation: buildInvocation({
            worker: input.worker,
            command: input.command,
            axis: input.axis,
            attempt: input.attempt,
            workerStartHead: input.workerStartHead,
            env: {},
          }),
          lines: input.lines,
          ...(input.truncatedStream === undefined
            ? {}
            : { truncatedStream: input.truncatedStream }),
        },
        {
          dir: '.test-evidence',
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );
      return settled.evidencePath;
    };

    const success = await runFixCycleCorrection('42', {
      runWorker: (_command, _args, onLine) => {
        onLine(progress);
        return Promise.resolve();
      },
      finalizeEvidence: realFinalizer,
      getHead: () => Promise.resolve('a'.repeat(40)),
    });
    expect(success.exitCode).toBe(0);
    expect(success.evidencePath).toContain('agent-fix-cycle');
    const persistedSuccess = JSON.parse([...written.values()].at(0) ?? '{}') as {
      lifecycle?: { errors?: Record<string, unknown> };
    };
    expect(persistedSuccess.lifecycle?.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
      apiStatusCounts: { '429': 1 },
      apiRetryableTrue: 1,
      apiRetryableFalse: 0,
      apiRetryableUnknown: 0,
    });

    written.clear();
    const failure = await runFixCycleCorrection('42', {
      runWorker: (_command, _args, onLine) => {
        onLine(progress);
        return Promise.reject(new Error('boom'));
      },
      finalizeEvidence: realFinalizer,
      getHead: () => Promise.resolve('a'.repeat(40)),
    });
    expect(failure.exitCode).toBe(1);
    expect(failure.reason).toMatch(/boom/);
    expect(failure.evidencePath).toContain('agent-fix-cycle');
    const persistedFailure = JSON.parse([...written.values()].at(0) ?? '{}') as {
      lifecycle?: { errors?: Record<string, unknown> };
    };
    expect(persistedFailure.lifecycle?.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
      apiStatusCounts: { '429': 1 },
      apiRetryableTrue: 1,
      apiRetryableFalse: 0,
      apiRetryableUnknown: 0,
    });

    written.clear();
    const timeout = await runFixCycleCorrection('42', {
      runWorker: (_command, _args, onLine) => {
        onLine(progress);
        return Promise.reject(new WorkerTimeoutError('address-review', 500, 'opencode', true));
      },
      finalizeEvidence: realFinalizer,
      writeSentinel: (path, contents) => {
        sentinels.set(path, contents);
        return Promise.resolve();
      },
      getHead: () => Promise.resolve('a'.repeat(40)),
    });
    expect(timeout.exitCode).toBe(1);
    expect(timeout.timedOut).toBe(true);
    expect(timeout.evidencePath).toContain('agent-fix-cycle');
    expect(sentinels.get('.address-review-timeout')).toContain('address-review timed out');
    const persistedTimeout = JSON.parse([...written.values()].at(0) ?? '{}') as {
      lifecycle?: { errors?: Record<string, unknown> };
    };
    expect(persistedTimeout.lifecycle?.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
      apiStatusCounts: { '429': 1 },
      apiRetryableTrue: 1,
    });
  });

  it('persists the additive summary through the shipped review worker-stream executor', async () => {
    // Invokes the exact shipped implementation used by review-cycle Standards,
    // Spec and loop-correction workers
    // (scripts/review/evidence-streaming-executor.ts, imported by
    // scripts/review-cycle.ts). No test-local executor replica remains.
    async function runShippedExecutor(input: {
      label: WorkerLabel;
      command: string;
      axis: string;
      script: string;
      timeoutMs?: number;
    }): Promise<{
      workerError: unknown;
      persisted: Record<string, unknown>;
      terminated: unknown;
      evidencePaths: readonly string[] | undefined;
    }> {
      const written = new Map<string, string>();
      const recorder = createRunSummaryRecorder();
      const executor = evidenceStreamingWorkerExecutor(
        input.label,
        {
          command: input.command,
          axis: input.axis,
          attempt: 1,
          workerStartHead: 'a'.repeat(40),
        },
        recorder,
        {
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          killGraceMs: 500,
          groupPollMs: 20,
          persistDeps: {
            dir: '.test-evidence',
            mkdir: () => Promise.resolve(),
            writeFile: (path: string, contents: string) => {
              written.set(path, contents);
              return Promise.resolve();
            },
          },
        },
      );
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      let workerError: unknown = null;
      try {
        await executor(process.execPath, ['-e', input.script]);
      } catch (error: unknown) {
        workerError = error;
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
      const persisted = JSON.parse([...written.values()].at(0) ?? '{}') as Record<string, unknown>;
      const summary = recorder.finish('READY');
      if (workerError === null) {
        return {
          workerError,
          persisted,
          terminated: true,
          evidencePaths: summary.skillEvidencePaths,
        };
      }
      return {
        workerError,
        persisted,
        terminated: (workerError as { terminated?: unknown }).terminated,
        evidencePaths: summary.skillEvidencePaths,
      };
    }

    const errorEnvelope = (status: number, retryable: boolean): string =>
      JSON.stringify({
        type: 'error',
        timestamp: 1700000000000,
        error: { name: 'APIError', data: { statusCode: status, isRetryable: retryable } },
      });
    const successScript = `console.log(${JSON.stringify(errorEnvelope(401, false))}); process.exit(0);`;
    const failureScript = `console.log(${JSON.stringify(errorEnvelope(429, true))}); process.exit(1);`;
    const timeoutScript = `console.log(${JSON.stringify(errorEnvelope(429, true))}); setInterval(() => undefined, 50);`;

    const invocations = [
      { label: 'standards', command: 'review-standards', axis: 'standards' },
      { label: 'spec', command: 'review-spec', axis: 'spec' },
      { label: 'address-review', command: 'address-review', axis: 'address-review' },
    ] as const satisfies readonly { label: WorkerLabel; command: string; axis: string }[];

    for (const invocation of invocations) {
      const success = await runShippedExecutor({ ...invocation, script: successScript });
      expect(success.workerError).toBeNull();
      expect(success.terminated).toBe(true);
      expect(success.evidencePaths).toHaveLength(1);
      expect(success.persisted).toMatchObject({
        lifecycle: {
          capturedLineCount: 1,
          errors: {
            total: 1,
            byName: { APIError: 1 },
            apiStatusCounts: { '401': 1 },
            apiRetryableTrue: 0,
            apiRetryableFalse: 1,
            apiRetryableUnknown: 0,
          },
        },
      });
    }

    for (const invocation of invocations) {
      const failure = await runShippedExecutor({ ...invocation, script: failureScript });
      expect(failure.workerError).not.toBeNull();
      expect(isWorkerTimeout(failure.workerError)).toBe(false);
      expect(failure.terminated).toBe(true);
      expect(failure.evidencePaths).toHaveLength(1);
      expect(failure.persisted).toMatchObject({
        lifecycle: {
          capturedLineCount: 1,
          errors: {
            total: 1,
            byName: { APIError: 1 },
            apiStatusCounts: { '429': 1 },
            apiRetryableTrue: 1,
            apiRetryableFalse: 0,
            apiRetryableUnknown: 0,
          },
        },
      });
      expect(JSON.stringify(failure.persisted)).toContain('"APIError"');
    }

    for (const invocation of invocations) {
      const timeout = await runShippedExecutor({
        ...invocation,
        script: timeoutScript,
        timeoutMs: 500,
      });
      expect(isWorkerTimeout(timeout.workerError)).toBe(true);
      expect(timeout.terminated).toBe(true);
      expect(timeout.evidencePaths).toHaveLength(1);
      expect(timeout.persisted).toMatchObject({
        lifecycle: {
          capturedLineCount: 1,
          errors: {
            total: 1,
            byName: { APIError: 1 },
            apiStatusCounts: { '429': 1 },
            apiRetryableTrue: 1,
            apiRetryableFalse: 0,
            apiRetryableUnknown: 0,
          },
        },
      });
    }
  }, 60000);

  it('keeps the record on persistence failure without manufacturing approval', async () => {
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'agent-ticket',
            command: 'implement',
            axis: 'implement',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines: [apiErrorLine(401, false)],
        },
        {
          mkdir: () => Promise.resolve(),
          writeFile: () => Promise.reject(new Error('disk gone')),
        },
      );

      expect(result.evidencePath).toBeUndefined();
      expect(result.record.lifecycle?.errors).toMatchObject({ total: 1 });
      expect(result.diagnostic).toMatch(/persistence failed/);
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('real subprocess error regression (ticket #138)', () => {
  function childScript(status: number, retryable: boolean): string {
    const envelope = JSON.stringify({
      type: 'error',
      timestamp: 1700000000000,
      error: { name: 'APIError', data: { statusCode: status, isRetryable: retryable } },
      message: 'sk-ant-child-message-must-not-persist',
      headers: { authorization: 'ghp_child-header' },
      body: 'child-body-sentinel',
    });
    // One complete protocol-shaped line, then a non-timeout failure.
    return `console.log(${JSON.stringify(envelope)}); process.exit(1);`;
  }

  async function runFailingChild(script: string): Promise<{
    lines: string[];
    failure: unknown;
  }> {
    const capture = createEvidenceCapture();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        process.execPath,
        ['-e', script],
        {
          label: 'error-fixture',
          killGraceMs: 500,
          groupPollMs: 20,
          stdoutLogFilter: suppressJsonWorkerLines,
        },
        undefined,
        {
          onStdoutLine: (line) => {
            capture.pushLine(line);
          },
        },
      );
      const failure = await pending.then(
        () => null,
        (error: unknown) => error,
      );
      return { lines: [...capture.lines], failure };
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }

  it('yields distinct persisted error diagnostics for 401 versus 429 with bounded termination', async () => {
    const first = await runFailingChild(childScript(401, false));
    const second = await runFailingChild(childScript(429, true));

    for (const run of [first, second]) {
      expect(run.failure).not.toBeNull();
      expect(isWorkerTimeout(run.failure)).toBe(false);
      expect(run.failure).toMatchObject({ terminated: true });
      expect(run.lines).toHaveLength(1);
    }

    const finalized401 = await finalizeToMemory(first.lines);
    const finalized429 = await finalizeToMemory(second.lines);

    expect(finalized401.result.record.lifecycle).toMatchObject({
      capturedLineCount: 1,
      eventCounts: { error: 1 },
      status: 'complete',
    });
    expect(finalized401.result.record.lifecycle?.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
      apiStatusCounts: { '401': 1 },
      apiRetryableFalse: 1,
    });
    expect(finalized429.result.record.lifecycle?.errors).toMatchObject({
      total: 1,
      byName: { APIError: 1 },
      apiStatusCounts: { '429': 1 },
      apiRetryableTrue: 1,
    });
    expect(JSON.stringify(finalized401.result.record.lifecycle?.errors)).not.toBe(
      JSON.stringify(finalized429.result.record.lifecycle?.errors),
    );
    // No skill or session attribution is fabricated from error-only streams.
    expect(finalized401.result.record.events).toEqual([]);
    expect(finalized401.result.record.coverage.primarySessionId).toBeNull();
    expect(finalized429.result.record.events).toEqual([]);
    const serialized = `${JSON.stringify(finalized401.persisted)}${JSON.stringify(finalized429.persisted)}`;
    expect(serialized).not.toMatch(/sk-ant-|ghp_|child-body-sentinel/);
    expect(serialized).toContain('"APIError"');
  }, 15000);
});
