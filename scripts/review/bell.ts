// Audible terminal notification for terminal review-cycle states (ticket #18).
// The bell rings only for terminal states in interactive TTY use and never in
// CI/non-TTY. Headless agents do not depend on it: human-required decisions
// are surfaced as explicit escalation output, never as hidden stdin prompts.
export const TERMINAL_BELL = '\x07';

export interface BellPolicy {
  noBell: boolean;
  isTTY: boolean;
  isCI: boolean;
}

export function shouldRingBell(policy: BellPolicy): boolean {
  if (policy.noBell) {
    return false;
  }
  if (policy.isCI) {
    return false;
  }
  return policy.isTTY;
}

export type BellWriter = (output: string) => void;

export function notifyTerminalState(policy: BellPolicy, write: BellWriter): void {
  if (!shouldRingBell(policy)) {
    return;
  }
  write(TERMINAL_BELL);
}

export function currentBellPolicy(noBell: boolean): BellPolicy {
  return {
    noBell,
    isTTY: process.stdout.isTTY,
    isCI: process.env.CI !== undefined && process.env.CI !== '',
  };
}

export function notifyTerminalBell(noBell: boolean): void {
  notifyTerminalState(currentBellPolicy(noBell), (output: string) => {
    process.stdout.write(output);
  });
}
