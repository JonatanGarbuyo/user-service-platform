import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runWorkerStream, type SpawnedWorker } from '../../scripts/review/worker-stream.js';

// Seam under test: live worker-output streaming (PR #17 dogfood finding).
// Long-running OpenCode workers must stream stdout/stderr with axis prefixes,
// lifecycle messages, and a silence heartbeat — buffering until exit is
// operationally indistinguishable from a hang. Tests inject a fake spawn so
// nothing depends on real subprocesses.
function createFakeChild(): { child: SpawnedWorker; stdout: EventEmitter; stderr: EventEmitter } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as unknown as SpawnedWorker;
  child.stdout = stdout;
  child.stderr = stderr;
  return { child, stdout, stderr };
}

describe('worker stream line handling', () => {
  it('streams chunked stdout with the axis prefix and resolves captured output', async () => {
    const { child, stdout } = createFakeChild();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'standards' },
        () => child,
      );
      stdout.emit('data', 'first half');
      stdout.emit('data', ' of a line\nsecond line\n');
      child.emit('close', 0);

      const result = await pending;

      expect(result).toEqual({ stdout: 'first half of a line\nsecond line\n', stderr: '' });
      expect(logSpy).toHaveBeenCalledWith('[standards] started: opencode run --auto');
      expect(logSpy).toHaveBeenCalledWith('[standards] first half of a line');
      expect(logSpy).toHaveBeenCalledWith('[standards] second line');
      expect(logSpy).toHaveBeenCalledWith('[standards] completed (exit 0)');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prefixes stderr separately and rejects with diagnostics on failure', async () => {
    const { child, stderr } = createFakeChild();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream('opencode', ['run'], { label: 'spec' }, () => child);
      stderr.emit('data', 'boom\n');
      child.emit('close', 1);

      await expect(pending).rejects.toThrow('boom');
      expect(errorSpy).toHaveBeenCalledWith('[spec] boom');
      expect(logSpy).toHaveBeenCalledWith('[spec] failed (exit 1)');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('emits a heartbeat while the worker is silent', async () => {
    vi.useFakeTimers();
    const { child, stdout } = createFakeChild();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let now = 1_000_000;
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run'],
        { label: 'spec', heartbeatMs: 30_000, now: () => now },
        () => child,
      );
      now += 30_000;
      await vi.advanceTimersByTimeAsync(30_000);

      expect(logSpy).toHaveBeenCalledWith('[spec] still running (30s elapsed, waiting for output)');

      stdout.emit('data', 'progress\n');
      await vi.advanceTimersByTimeAsync(29_000);
      const heartbeats = logSpy.mock.calls.filter((call) =>
        String(call[0]).includes('still running'),
      );
      expect(heartbeats).toHaveLength(1);

      child.emit('close', 0);
      await pending;
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
