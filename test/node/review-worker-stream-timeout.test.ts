import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { isWorkerTimeout } from '../../scripts/review/worker-timeout.js';
import { runWorkerStream, type SpawnedWorker } from '../../scripts/review/worker-stream.js';

// Seam under test: bounded worker execution (ticket #31).
// A hung OpenCode worker must reject with a distinguishable timeout (not a
// generic exit failure) and its subprocess tree must be terminated cleanly so
// no orphan process continues after the workflow has stopped.
function createKillableChild(): {
  child: SpawnedWorker & { kill: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as unknown as SpawnedWorker & {
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn(() => true);
  return { child, stdout, stderr };
}

describe('worker stream timeout', () => {
  it('rejects with a worker timeout when the worker exceeds its bound', async () => {
    vi.useFakeTimers();
    const { child } = createKillableChild();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'standards', timeoutMs: 1_000 },
        () => child,
      );
      const assertion = expect(pending).rejects.toSatisfy(isWorkerTimeout);
      await vi.advanceTimersByTimeAsync(1_500);
      await assertion;
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[standards]'));
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('terminates the hung subprocess tree instead of leaving an orphan', async () => {
    vi.useFakeTimers();
    const { child } = createKillableChild();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'spec', timeoutMs: 500 },
        () => child,
      );
      const assertion = expect(pending).rejects.toSatisfy(isWorkerTimeout);
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.mocked(console.log).mockRestore();
      vi.useRealTimers();
    }
  });

  it('resolves normally when the worker finishes before its bound', async () => {
    const { child, stdout } = createKillableChild();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'implement', timeoutMs: 60_000 },
        () => child,
      );
      stdout.emit('data', 'done\n');
      child.emit('close', 0);
      const result = await pending;
      expect(result.stdout).toBe('done\n');
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});
