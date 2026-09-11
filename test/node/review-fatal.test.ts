import { describe, expect, it, vi } from 'vitest';
import {
  formatFatalMessage,
  handleFatalTermination,
  parseNoBellFlag,
  runWithFatalBoundary,
} from '../../scripts/review/fatal.js';

// Seam under test: top-level fatal-error boundary for the review cycle (final
// acceptance on PR #19). Handled terminal paths return normally with their own
// notification; only an unhandled rejection/exception reaches this boundary.
// It must report REVIEW-CYCLE FATAL, set a non-zero exit code, and ring the
// bell exactly once per the existing TTY/CI/--no-bell policy.
describe('fatal-error boundary', () => {
  it('parses --no-bell with last-wins semantics', () => {
    expect(parseNoBellFlag([])).toBe(false);
    expect(parseNoBellFlag(['--no-bell'])).toBe(true);
    expect(parseNoBellFlag(['--no-bell', '--bell'])).toBe(false);
    expect(parseNoBellFlag(['--bell', '--no-bell'])).toBe(true);
  });

  it('formats a clear fatal message for Error and non-Error values', () => {
    expect(formatFatalMessage(new Error('worker blew up'))).toBe(
      'REVIEW-CYCLE FATAL: worker blew up',
    );
    expect(formatFatalMessage('plain string')).toBe('REVIEW-CYCLE FATAL: plain string');
  });

  it('reports FATAL, sets exit code 1, and notifies once when interactive', () => {
    const logError = vi.fn();
    const setExitCode = vi.fn();
    const notify = vi.fn();

    handleFatalTermination(new Error('boom'), false, {
      logError,
      setExitCode,
      policy: { noBell: false, isTTY: true, isCI: false },
      notify,
    });

    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).toContain('REVIEW-CYCLE FATAL');
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the bell policy forbids it', () => {
    const notify = vi.fn();

    handleFatalTermination(new Error('boom'), true, {
      logError: () => undefined,
      setExitCode: () => undefined,
      policy: { noBell: true, isTTY: true, isCI: false },
      notify,
    });

    expect(notify).not.toHaveBeenCalled();
  });

  it('routes a rejected worker/operation to the fatal notification policy', async () => {
    const logError = vi.fn();
    const setExitCode = vi.fn();
    const notify = vi.fn();
    const rejected = (): Promise<void> => Promise.reject(new Error('worker exit 1'));

    await runWithFatalBoundary(rejected, [], {
      logError,
      setExitCode,
      policy: { noBell: false, isTTY: true, isCI: false },
      notify,
    });

    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).toContain('REVIEW-CYCLE FATAL');
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not trigger the fatal path when the operation succeeds', async () => {
    const logError = vi.fn();
    const notify = vi.fn();

    await runWithFatalBoundary(() => Promise.resolve(), [], {
      logError,
      setExitCode: () => undefined,
      policy: { noBell: false, isTTY: true, isCI: false },
      notify,
    });

    expect(logError).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('derives --no-bell from argv on the real default path', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalIsTTY = process.stdout.isTTY;
    const originalCI = process.env.CI;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env.CI;
    try {
      const setExitCode = vi.fn();
      await runWithFatalBoundary(() => Promise.reject(new Error('boom')), ['--no-bell'], {
        logError: () => undefined,
        setExitCode,
      });

      expect(setExitCode).toHaveBeenCalledWith(1);
      expect(writeSpy).not.toHaveBeenCalledWith('\x07');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
      writeSpy.mockRestore();
    }
  });

  it('rings once on the real default path without --no-bell', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalIsTTY = process.stdout.isTTY;
    const originalCI = process.env.CI;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    delete process.env.CI;
    try {
      await runWithFatalBoundary(() => Promise.reject(new Error('boom')), [], {
        logError: () => undefined,
        setExitCode: () => undefined,
      });

      expect(writeSpy).toHaveBeenCalledWith('\x07');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
      writeSpy.mockRestore();
    }
  });
});
