import { currentBellPolicy, notifyTerminalState, shouldRingBell, type BellPolicy } from './bell.js';

// Top-level fatal-error boundary for the review cycle (final acceptance on
// PR #19). Handled terminal paths inside `main()` return normally with their
// own notification; only an unhandled rejection/exception — e.g. a failed
// OpenCode worker via `runWorkerStream()` — reaches this boundary. It reports
// a clear REVIEW-CYCLE FATAL message, sets a non-zero exit code, and rings the
// bell exactly once per the existing TTY/CI/--no-bell policy. Headless agents
// keep working: the fatal state is explicit escalation output, never a hidden
// stdin prompt.
export function parseNoBellFlag(argv: readonly string[]): boolean {
  let noBell = false;
  for (const arg of argv) {
    if (arg === '--no-bell') {
      noBell = true;
    } else if (arg === '--bell') {
      noBell = false;
    }
  }
  return noBell;
}

export function formatFatalMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `REVIEW-CYCLE FATAL: ${detail}`;
}

export interface FatalHandlerDeps {
  logError?: (message: string) => void;
  setExitCode?: (code: number) => void;
  policy?: BellPolicy;
  notify?: (policy: BellPolicy) => void;
}

export function handleFatalTermination(
  error: unknown,
  noBell: boolean,
  deps: FatalHandlerDeps = {},
): void {
  const logError = deps.logError ?? console.error;
  const setExitCode =
    deps.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const policy = deps.policy ?? currentBellPolicy(noBell);
  const notify =
    deps.notify ??
    ((bellPolicy: BellPolicy) => {
      notifyTerminalState(bellPolicy, (output: string) => {
        process.stdout.write(output);
      });
    });
  logError(formatFatalMessage(error));
  setExitCode(1);
  if (shouldRingBell(policy)) {
    notify(policy);
  }
}

export async function runWithFatalBoundary(
  mainFn: () => Promise<void>,
  argv: readonly string[],
  deps: FatalHandlerDeps = {},
): Promise<void> {
  try {
    await mainFn();
  } catch (error) {
    handleFatalTermination(error, parseNoBellFlag(argv), deps);
  }
}
