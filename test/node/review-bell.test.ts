import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_BELL, notifyTerminalState, shouldRingBell } from '../../scripts/review/bell.js';

// Seam under test: audible terminal notification policy (ticket #18). The bell
// rings only for terminal review-cycle states in interactive TTY use, never in
// CI/non-TTY, and can be disabled with --no-bell.
describe('terminal bell policy', () => {
  it('rings only for interactive TTY use without --no-bell or CI', () => {
    expect(shouldRingBell({ noBell: false, isTTY: true, isCI: false })).toBe(true);
  });

  it('stays silent when --no-bell is passed', () => {
    expect(shouldRingBell({ noBell: true, isTTY: true, isCI: false })).toBe(false);
  });

  it('stays silent when stdout is not a TTY', () => {
    expect(shouldRingBell({ noBell: false, isTTY: false, isCI: false })).toBe(false);
  });

  it('stays silent in CI even when stdout is a TTY', () => {
    expect(shouldRingBell({ noBell: false, isTTY: true, isCI: true })).toBe(false);
  });

  it('emits a single BEL character for terminal states when enabled', () => {
    const write = vi.fn();
    notifyTerminalState({ noBell: false, isTTY: true, isCI: false }, write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(TERMINAL_BELL);
  });

  it('never emits bell control characters when disabled', () => {
    const write = vi.fn();
    notifyTerminalState({ noBell: false, isTTY: false, isCI: false }, write);
    notifyTerminalState({ noBell: true, isTTY: true, isCI: false }, write);
    notifyTerminalState({ noBell: false, isTTY: true, isCI: true }, write);
    expect(write).not.toHaveBeenCalled();
  });
});
