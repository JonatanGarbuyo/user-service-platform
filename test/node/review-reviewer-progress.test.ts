import { describe, expect, it, vi } from 'vitest';
import { createRunSummaryRecorder } from '../../scripts/review/run-summary.js';
import { evidenceStreamingWorkerExecutor } from '../../scripts/review/evidence-streaming-executor.js';
import { isWorkerTimeout } from '../../scripts/review/worker-timeout.js';
import {
  PROGRESS_VERSION,
  progressFileName,
  projectReviewerProgress,
  serializeReviewerProgress,
  startReviewerProgressProbe,
  type ReviewerProgressIdentity,
} from '../../scripts/review/reviewer-progress.js';

// Seams under test: timeout-resilient reviewer-progress projection (ticket #161).
// The probe reuses the shared worker-lifecycle projection so a Standards timeout
// retains useful allowlisted progress (timestamps, counts/tool names,
// lineage/status/completeness) instead of an unavailable record. Observer
// liveness never counts as reviewer progress, and no text, reasoning, prompts,
// tool inputs/outputs, credentials or user data may enter durable evidence.
function toolLine(call: string, session: string, tool: string, timestamp: number): string {
  return JSON.stringify({
    type: 'tool_use',
    timestamp,
    sessionID: session,
    part: {
      id: call,
      sessionID: session,
      messageID: 'msg-1',
      type: 'tool',
      tool,
      state: { status: 'completed' },
    },
  });
}

function stepLine(timestamp: number): string {
  return JSON.stringify({ type: 'step_start', timestamp });
}

const identity: ReviewerProgressIdentity = {
  worker: 'review-cycle',
  command: 'review-standards',
  axis: 'standards',
  attempt: 1,
  workerStartHead: '93171c25ecc6d2f360d94c8d02af5e773b65defa',
  boundMs: 1_200_000,
};

describe('reviewer progress projection', () => {
  it('projects allowlisted counts and timestamps from known worker lines', () => {
    const lines = [
      toolLine('call-1', 'session-1', 'read', 1_700_000_000_000),
      toolLine('call-2', 'session-1', 'read', 1_700_000_060_000),
      stepLine(1_700_000_030_000),
    ];
    const snapshot = projectReviewerProgress(lines, identity, 3, {
      observedAt: '2026-10-15T16:00:03Z',
    });

    expect(snapshot.version).toBe(PROGRESS_VERSION);
    expect(snapshot.identity).toEqual(identity);
    expect(snapshot.sequence).toBe(3);
    expect(snapshot.observedAt).toBe('2026-10-15T16:00:03Z');
    expect(snapshot.capturedLineCount).toBe(3);
    expect(snapshot.eventCounts).toEqual({ tool_use: 2, step_start: 1 });
    expect(snapshot.toolCounts).toEqual({ read: 2 });
    expect(snapshot.firstTimestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(snapshot.lastTimestamp).toBe('2023-11-14T22:14:20.000Z');
    expect(snapshot.durationMs).toBe(60_000);
    expect(snapshot.lastStatus).toBe('completed');
    expect(snapshot.malformed).toBe(0);
    expect(snapshot.unknownEvents).toBe(0);
    expect(snapshot.status).toBe('complete');
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.captureTruncated).toBe(false);
  });

  it('reports unavailable when no worker events were captured', () => {
    const snapshot = projectReviewerProgress([], identity, 7, {
      observedAt: '2026-10-15T16:20:00Z',
    });

    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.reasons).toContain('no worker events captured');
    expect(snapshot.eventCounts).toEqual({});
    expect(snapshot.toolCounts).toEqual({});
    expect(snapshot.lastStatus).toBeNull();
    // Observer cadence metadata advances, but it is not reviewer progress:
    // no worker counts, timestamps or completeness may be fabricated.
    expect(snapshot.sequence).toBe(7);
    expect(snapshot.observedAt).toBe('2026-10-15T16:20:00Z');
    expect(snapshot.firstTimestamp).toBeNull();
    expect(snapshot.durationMs).toBeNull();
  });

  it('never counts observer liveness as reviewer progress', () => {
    const lines = [
      '[standards] still running (42s elapsed, waiting for output)',
      '[standards] started: opencode run --auto --command review-standards 154',
    ];
    const snapshot = projectReviewerProgress(lines, identity, 2, {
      observedAt: '2026-10-15T16:01:00Z',
    });

    expect(snapshot.status).not.toBe('complete');
    expect(snapshot.eventCounts).toEqual({});
    expect(snapshot.toolCounts).toEqual({});
    expect(snapshot.lastStatus).toBeNull();
  });

  it('never persists text, reasoning, prompts, tool I/O or credentials', () => {
    const lines = [
      JSON.stringify({
        type: 'text',
        timestamp: 1_700_000_000_000,
        text: 'secret plan with sk-ant-secret-marker-123 and ghp_secret-marker-456',
      }),
      JSON.stringify({
        type: 'reasoning',
        timestamp: 1_700_000_001_000,
        reasoning: 'OPENCODE_ZEN_API_KEY=leak-marker-789 in mind',
      }),
      toolLine('call-9', 'session-9', 'bash', 1_700_000_002_000),
    ];
    const snapshot = projectReviewerProgress(lines, identity, 1, {
      observedAt: '2026-10-15T16:00:01Z',
    });
    const serialized = serializeReviewerProgress(snapshot);

    expect(serialized).not.toContain('sk-ant-secret-marker-123');
    expect(serialized).not.toContain('ghp_secret-marker-456');
    expect(serialized).not.toContain('leak-marker-789');
    expect(serialized).not.toContain('secret plan');
    expect(snapshot.toolCounts).toEqual({ bash: 1 });
  });

  it('derives allowlisted file names from invocation identity', () => {
    expect(progressFileName(identity)).toBe('review-standards-standards-1.json');
  });
});

describe('reviewer progress probe', () => {
  function memoryStore(): {
    files: Map<string, string>;
    mkdir: () => Promise<unknown>;
    writeFile: (path: string, contents: string) => Promise<unknown>;
  } {
    const files = new Map<string, string>();
    return {
      files,
      mkdir: () => Promise.resolve(undefined),
      writeFile: (path: string, contents: string) => {
        files.set(path, contents);
        return Promise.resolve(undefined);
      },
    };
  }

  it('persists incremental snapshots as worker lines arrive', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const store = memoryStore();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const probe = startReviewerProgressProbe(
        identity,
        { lines, wasTruncated: () => false },
        {
          dir: '.review-cycle/progress',
          intervalMs: 60_000,
          now: () => '2026-10-15T16:01:00Z',
          mkdir: store.mkdir,
          writeFile: store.writeFile,
        },
      );
      try {
        lines.push(toolLine('call-1', 'session-1', 'read', 1_700_000_000_000));
        lines.push(toolLine('call-2', 'session-1', 'bash', 1_700_000_030_000));
        await vi.advanceTimersByTimeAsync(60_000);
        lines.push(stepLine(1_700_000_060_000));
        await vi.advanceTimersByTimeAsync(60_000);
      } finally {
        probe.stop();
      }
      expect(store.files.size).toBe(1);
      const raw = store.files.get('.review-cycle/progress/review-standards-standards-1.json');
      expect(raw).toBeDefined();
      const latest = JSON.parse(raw ?? '') as {
        sequence: number;
        capturedLineCount: number;
        eventCounts: Record<string, number>;
        toolCounts: Record<string, number>;
        status: string;
        observedAt: string;
      };
      expect(latest.sequence).toBe(2);
      expect(latest.capturedLineCount).toBe(3);
      expect(latest.eventCounts).toEqual({ tool_use: 2, step_start: 1 });
      expect(latest.toolCounts).toEqual({ read: 1, bash: 1 });
      expect(latest.status).toBe('complete');
      expect(latest.observedAt).toBe('2026-10-15T16:01:00Z');
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps unavailable status across observer ticks without worker lines', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const store = memoryStore();
    try {
      const probe = startReviewerProgressProbe(
        identity,
        { lines, wasTruncated: () => false },
        {
          dir: '.review-cycle/progress',
          intervalMs: 60_000,
          now: () => '2026-10-15T16:20:00Z',
          mkdir: store.mkdir,
          writeFile: store.writeFile,
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(180_000);
      } finally {
        probe.stop();
      }
      const raw = store.files.get('.review-cycle/progress/review-standards-standards-1.json');
      const latest = JSON.parse(raw ?? '') as {
        sequence: number;
        status: string;
        reasons: string[];
        eventCounts: Record<string, number>;
      };
      expect(latest.sequence).toBe(3);
      expect(latest.status).toBe('unavailable');
      expect(latest.reasons).toContain('no worker events captured');
      expect(latest.eventCounts).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws or leaks failure detail when persistence fails', async () => {
    const lines: string[] = [toolLine('call-1', 'session-1', 'read', 1_700_000_000_000)];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const probe = startReviewerProgressProbe(
        identity,
        { lines, wasTruncated: () => false },
        {
          dir: '.review-cycle/progress',
          intervalMs: 60_000,
          now: () => '2026-10-15T16:01:00Z',
          mkdir: () => Promise.resolve(undefined),
          writeFile: () => Promise.reject(new Error('disk full: sk-ant-boom-marker')),
        },
      );
      try {
        await expect(probe.snapshotNow()).resolves.toBeUndefined();
      } finally {
        probe.stop();
      }
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(message).not.toContain('sk-ant-boom-marker');
      expect(message).toContain('standards');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('stops persisting after stop', async () => {
    vi.useFakeTimers();
    const lines: string[] = [];
    const store = memoryStore();
    try {
      const probe = startReviewerProgressProbe(
        identity,
        { lines, wasTruncated: () => false },
        {
          dir: '.review-cycle/progress',
          intervalMs: 60_000,
          now: () => '2026-10-15T16:01:00Z',
          mkdir: store.mkdir,
          writeFile: store.writeFile,
        },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.files.size).toBe(1);
      probe.stop();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(store.files.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reviewer progress executor wiring', () => {
  // Seam under test: the shipped evidence-streaming executor
  // (scripts/review/evidence-streaming-executor.ts) used by review-cycle
  // Standards, Spec and loop-correction workers. Real worker subprocesses
  // with controlled short bounds prove incremental progress survives a
  // timeout, unobservable progress stays unknown, and capture failures never
  // mask the reviewer result.
  async function runShippedExecutor(input: {
    script: string;
    timeoutMs?: number;
    progress?: {
      enabled?: boolean;
      intervalMs?: number;
      writeFile?: (path: string, contents: string) => Promise<unknown>;
    };
  }): Promise<{ workerError: unknown; progressFiles: Map<string, string> }> {
    const progressFiles = new Map<string, string>();
    const recorder = createRunSummaryRecorder();
    const executor = evidenceStreamingWorkerExecutor(
      'standards',
      {
        command: 'review-standards',
        axis: 'standards',
        attempt: 1,
        workerStartHead: 'a'.repeat(40),
      },
      recorder,
      {
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        killGraceMs: 200,
        groupPollMs: 10,
        persistDeps: {
          dir: '.test-evidence',
          mkdir: () => Promise.resolve(),
          writeFile: () => Promise.resolve(),
        },
        exporter: () => Promise.resolve(null),
        progress: {
          dir: '.test-progress',
          intervalMs: 100,
          now: () => '2026-10-15T16:01:00Z',
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            progressFiles.set(path, contents);
            return Promise.resolve();
          },
          ...(input.progress ?? {}),
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
    return { workerError, progressFiles };
  }

  it('retains incremental progress when the worker times out', async () => {
    const emit = `console.log(${JSON.stringify(toolLine('call-1', 'session-1', 'read', 1_700_000_000_000))});console.log(${JSON.stringify(toolLine('call-2', 'session-1', 'bash', 1_700_000_030_000))});`;
    const { workerError, progressFiles } = await runShippedExecutor({
      script: `${emit} setInterval(() => undefined, 50);`,
      timeoutMs: 600,
    });

    expect(isWorkerTimeout(workerError)).toBe(true);
    const raw = progressFiles.get('.test-progress/review-standards-standards-1.json');
    expect(raw).toBeDefined();
    const latest = JSON.parse(raw ?? '') as {
      capturedLineCount: number;
      eventCounts: Record<string, number>;
      toolCounts: Record<string, number>;
      firstTimestamp: string;
      lastTimestamp: string;
      status: string;
      reasons: string[];
      identity: { command: string; axis: string; attempt: number; boundMs: number };
    };
    expect(latest.capturedLineCount).toBe(2);
    expect(latest.eventCounts).toEqual({ tool_use: 2 });
    expect(latest.toolCounts).toEqual({ read: 1, bash: 1 });
    expect(latest.firstTimestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(latest.lastTimestamp).toBe('2023-11-14T22:13:50.000Z');
    expect(latest.status).toBe('complete');
    expect(latest.reasons).toEqual([]);
    expect(latest.identity).toMatchObject({
      command: 'review-standards',
      axis: 'standards',
      attempt: 1,
      boundMs: 600,
    });
  }, 30000);

  it('keeps an explicit unavailable record when the timed-out worker emitted nothing', async () => {
    const { workerError, progressFiles } = await runShippedExecutor({
      script: 'setInterval(() => undefined, 50);',
      timeoutMs: 500,
    });

    expect(isWorkerTimeout(workerError)).toBe(true);
    const raw = progressFiles.get('.test-progress/review-standards-standards-1.json');
    expect(raw).toBeDefined();
    const latest = JSON.parse(raw ?? '') as {
      status: string;
      reasons: string[];
      eventCounts: Record<string, number>;
    };
    expect(latest.status).toBe('unavailable');
    expect(latest.reasons).toContain('no worker events captured');
    expect(latest.eventCounts).toEqual({});
  }, 30000);

  it('never lets probe persistence failure mask worker success', async () => {
    const emit = `console.log(${JSON.stringify(toolLine('call-1', 'session-1', 'read', 1_700_000_000_000))});`;
    const { workerError, progressFiles } = await runShippedExecutor({
      script: `${emit} process.exit(0);`,
      progress: {
        writeFile: () => Promise.reject(new Error('disk gone')),
      },
    });

    expect(workerError).toBeNull();
    expect(progressFiles.size).toBe(0);
  }, 30000);

  it('writes nothing when the probe is disabled', async () => {
    const emit = `console.log(${JSON.stringify(toolLine('call-1', 'session-1', 'read', 1_700_000_000_000))});`;
    const { workerError, progressFiles } = await runShippedExecutor({
      script: `${emit} process.exit(0);`,
      progress: { enabled: false },
    });

    expect(workerError).toBeNull();
    expect(progressFiles.size).toBe(0);
  }, 30000);
});
