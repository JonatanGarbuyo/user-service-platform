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
      // Bounded handshake: the worker has not exited yet, so the rejection
      // waits; closing the worker completes the timeout with termination.
      child.emit('close', 1);
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
      expect(child.kill).toHaveBeenCalled();
      child.emit('close', 1);
      await assertion;
    } finally {
      vi.mocked(console.log).mockRestore();
      vi.useRealTimers();
    }
  });

  it('kills the whole process group so grandchildren cannot survive', async () => {
    vi.useFakeTimers();
    const { child } = createKillableChild();
    (child as { pid?: number }).pid = 424242;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'standards', timeoutMs: 500 },
        () => child,
      );
      const assertion = expect(pending).rejects.toSatisfy(isWorkerTimeout);
      await vi.advanceTimersByTimeAsync(600);
      expect(child.kill).toHaveBeenCalled();
      expect(killSpy).toHaveBeenCalledWith(-424242, 'SIGTERM');
      child.emit('close', 1);
      await assertion;
    } finally {
      logSpy.mockRestore();
      killSpy.mockRestore();
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

  it('waits for worker close after timeout so capture does not race a still-writing implementer', async () => {
    vi.useFakeTimers();
    const { child, stdout } = createKillableChild();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'implement', timeoutMs: 1_000, killGraceMs: 5_000 },
        () => child,
      );
      let settled = false;
      let terminated: boolean | undefined;
      void pending.then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          terminated = (error as { terminated?: boolean }).terminated;
        },
      );
      await vi.advanceTimersByTimeAsync(1_500);
      // Timeout fired and SIGTERM was sent, but the worker has not exited:
      // the timeout rejection must wait for bounded termination.
      expect(child.kill).toHaveBeenCalled();
      expect(settled).toBe(false);
      // The worker writes during the grace period, then exits: the rejection
      // carries terminated=true and the grace-period output is preserved.
      stdout.emit('data', 'grace-write\n');
      child.emit('close', 1);
      await vi.advanceTimersByTimeAsync(0);
      await expect(pending).rejects.toSatisfy(isWorkerTimeout);
      expect(settled).toBe(true);
      expect(terminated).toBe(true);
      await expect(pending).rejects.toMatchObject({ terminated: true });
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('escalates to SIGKILL when the worker ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const { child } = createKillableChild();
    (child as { pid?: number }).pid = 424243;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'implement', timeoutMs: 500, killGraceMs: 1_000 },
        () => child,
      );
      const assertion = expect(pending).rejects.toSatisfy(isWorkerTimeout);
      await vi.advanceTimersByTimeAsync(600);
      expect(killSpy).toHaveBeenCalledWith(-424243, 'SIGTERM');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(killSpy).toHaveBeenCalledWith(-424243, 'SIGKILL');
      child.emit('close', 1);
      await assertion;
    } finally {
      logSpy.mockRestore();
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('rejects bounded with terminated=false when the worker never exits', async () => {
    vi.useFakeTimers();
    const { child } = createKillableChild();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto'],
        { label: 'implement', timeoutMs: 500, killGraceMs: 1_000 },
        () => child,
      );
      const assertion = expect(pending).rejects.toMatchObject({ terminated: false });
      // Timeout (500ms) + SIGKILL grace (1000ms) + termination deadline.
      await vi.advanceTimersByTimeAsync(500 + 1_000 + 1_000 + 100);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
