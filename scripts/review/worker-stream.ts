import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { WORKER_KILL_GRACE_MS, WorkerTimeoutError } from './worker-timeout.js';

export interface StreamHandlers {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface WorkerStreamOptions {
  label: string;
  heartbeatMs?: number;
  now?: () => number;
  // Bounded execution (ticket #31): when set, a silent or hung worker is
  // terminated and the promise rejects with a distinguishable
  // `WorkerTimeoutError` instead of hanging indefinitely. Callers pass the
  // per-worker bound from `timeoutForWorker`; no default is applied here so
  // short deterministic commands stay on the buffered `runCommand` path.
  timeoutMs?: number;
  killGraceMs?: number;
  // Evidence-enabled workers (ticket #116) stream `--format json`, whose raw
  // tool parts, text, reasoning and output must never become console logs.
  // When provided, a stdout line is echoed only when the filter returns true;
  // the line is still captured in `stdout` and delivered to `onStdoutLine`.
  // Lifecycle messages (started/completed/failed/heartbeat) are unaffected.
  stdoutLogFilter?: (line: string) => boolean;
  // Process-group liveness probe (ticket #127): the direct child can close
  // while a SIGTERM-ignoring descendant survives, so termination is only
  // established when the group is gone. Tests inject a faithful stub; the
  // default probes with `process.kill(-pid, 0)`.
  groupAlive?: (pid: number) => boolean;
  // Poll interval for group-exit verification after the direct child closes.
  groupPollMs?: number;
}

// Default group-liveness probe: signal 0 performs existence checking without
// delivering a signal. ESRCH means the group is gone; any other outcome
// (including EPERM) conservatively reports alive so termination is never
// claimed from a torn snapshot.
function defaultIsGroupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

export type SpawnFn = (command: string, args: readonly string[]) => SpawnedWorker;

// Minimal structural seam over the spawned worker: the real `spawn()` result
// satisfies this, and tests inject EventEmitters without real subprocesses.
// `kill` terminates the hung subprocess tree so no orphan OpenCode process
// continues after the workflow has stopped.
export interface SpawnedWorker extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  kill?: (signal?: number | NodeJS.Signals) => unknown;
  pid?: number;
}

export interface WorkerStreamResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_HEARTBEAT_MS = 30_000;

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

// Splits streamed chunks into complete lines, keeping a trailing partial line
// buffered until the rest arrives or the stream closes.
function pushChunk(buffer: { text: string }, chunk: string, onLine: (line: string) => void): void {
  buffer.text += chunk;
  let index = buffer.text.indexOf('\n');
  while (index >= 0) {
    onLine(stripCarriageReturn(buffer.text.slice(0, index)));
    buffer.text = buffer.text.slice(index + 1);
    index = buffer.text.indexOf('\n');
  }
}

// Live streaming execution for long-running OpenCode workers (PR #17 dogfood
// finding). Short deterministic commands (git/gh/npm gates) stay on the
// buffered `runCommand` path; workers run here so concurrent axes stream
// prefixed output, lifecycle messages, and a silence heartbeat instead of
// appearing frozen until exit.
export function runWorkerStream(
  command: string,
  args: readonly string[],
  options: WorkerStreamOptions,
  spawnFn: SpawnFn = (cmd, argv) =>
    spawn(cmd, [...argv], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  handlers: StreamHandlers = {},
): Promise<WorkerStreamResult> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  const invocation = `${command} ${args.join(' ')}`;

  return new Promise<WorkerStreamResult>((resolve, reject) => {
    console.log(`[${options.label}] started: ${invocation}`);
    const child = spawnFn(command, args);
    const startedAt = now();
    let lastActivity = startedAt;
    let stdout = '';
    let stderr = '';
    const stdoutBuffer = { text: '' };
    const stderrBuffer = { text: '' };
    let settled = false;

    const heartbeat = setInterval(() => {
      if (now() - lastActivity >= heartbeatMs) {
        const elapsedSeconds = Math.floor((now() - startedAt) / 1000);
        console.log(
          `[${options.label}] still running (${String(elapsedSeconds)}s elapsed, waiting for output)`,
        );
      }
    }, heartbeatMs);
    // Avoid holding the event loop open for diagnostic timers.
    if (typeof (heartbeat as unknown as { unref?: unknown }).unref === 'function') {
      (heartbeat as unknown as { unref: () => void }).unref();
    }

    // The worker runs detached in its own process group so the watchdog can
    // terminate the whole tree: `child.kill()` alone only signals the direct
    // child, leaving `opencode` grandchildren orphaned (ticket #31 context).
    const killTree = (signal: number | NodeJS.Signals): void => {
      try {
        child.kill?.(signal);
      } catch {
        // Best-effort: termination must never mask the timeout itself.
      }
      const pid = child.pid;
      if (pid !== undefined && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(-pid, signal);
        } catch {
          // Best-effort: the group may already be gone.
        }
      }
    };

    // Bounded watchdog (ticket #31) with termination handshake (ticket #127):
    // terminate the hung subprocess tree and reject with a distinguishable
    // timeout so callers can report TIMEOUT rather than a generic exit
    // failure. SIGTERM first, SIGKILL after the kill grace so no orphan
    // OpenCode process continues. The rejection waits for bounded process-group
    // exit so a recovery snapshot taken after the rejection does not race a
    // still-writing implementer; a direct-child close or error alone never
    // establishes termination while the group stays alive. When group exit
    // cannot be established within the termination deadline the error carries
    // terminated=false and callers must retain unavailable evidence instead of
    // reading a changing worktree.
    const timeoutMs = options.timeoutMs;
    const killGraceMs = options.killGraceMs ?? WORKER_KILL_GRACE_MS;
    const isGroupAlive = options.groupAlive ?? defaultIsGroupAlive;
    const groupPollMs = options.groupPollMs ?? 50;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let killEscalation: ReturnType<typeof setTimeout> | undefined;
    let terminationDeadline: ReturnType<typeof setTimeout> | undefined;
    let groupPoll: ReturnType<typeof setInterval> | undefined;
    let timedOut = false;
    const clearTerminationTimers = (): void => {
      if (killEscalation !== undefined) {
        clearTimeout(killEscalation);
        killEscalation = undefined;
      }
      if (terminationDeadline !== undefined) {
        clearTimeout(terminationDeadline);
        terminationDeadline = undefined;
      }
      if (groupPoll !== undefined) {
        clearInterval(groupPoll);
        groupPoll = undefined;
      }
    };
    const isGroupGone = (): boolean => {
      const pid = child.pid;
      if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
        return true;
      }
      try {
        return !isGroupAlive(pid);
      } catch {
        // A failing probe never establishes exit: stay conservative.
        return false;
      }
    };
    const settleTimeout = (terminated: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
      clearTerminationTimers();
      if (!terminated) {
        console.log(`[${options.label}] termination unconfirmed; reporting timeout`);
      }
      reject(new WorkerTimeoutError(options.label, timeoutMs ?? 0, invocation, terminated));
    };
    const startGroupPoll = (): void => {
      if (groupPoll !== undefined || settled) {
        return;
      }
      groupPoll = setInterval(() => {
        if (settled) {
          return;
        }
        if (isGroupGone()) {
          settleTimeout(true);
        }
      }, groupPollMs);
      if (typeof (groupPoll as unknown as { unref?: unknown }).unref === 'function') {
        (groupPoll as unknown as { unref: () => void }).unref();
      }
    };
    if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      watchdog = setTimeout(() => {
        if (settled || timedOut) {
          return;
        }
        timedOut = true;
        clearInterval(heartbeat);
        console.log(`[${options.label}] timed out after ${String(timeoutMs)}ms; terminating`);
        killTree('SIGTERM');
        killEscalation = setTimeout(() => {
          console.log(`[${options.label}] still terminating; escalating to SIGKILL`);
          killTree('SIGKILL');
        }, killGraceMs);
        if (typeof (killEscalation as unknown as { unref?: unknown }).unref === 'function') {
          (killEscalation as unknown as { unref: () => void }).unref();
        }
        terminationDeadline = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          clearTerminationTimers();
          console.log(`[${options.label}] termination unconfirmed; reporting timeout`);
          reject(new WorkerTimeoutError(options.label, timeoutMs, invocation, false));
        }, killGraceMs * 2);
        if (typeof (terminationDeadline as unknown as { unref?: unknown }).unref === 'function') {
          (terminationDeadline as unknown as { unref: () => void }).unref();
        }
      }, timeoutMs);
      if (typeof (watchdog as unknown as { unref?: unknown }).unref === 'function') {
        (watchdog as unknown as { unref: () => void }).unref();
      }
    }

    const finish = (error: Error | null, exitCode: number | null): void => {
      if (settled) {
        return;
      }
      if (timedOut) {
        // The bound already fired. An `error` event alone never establishes
        // exit: wait for `close` or the termination deadline instead.
        if (error !== null) {
          return;
        }
        // The direct child can close while a SIGTERM-ignoring descendant
        // survives with closed/ignored stdio. Only the process group going
        // away establishes termination; otherwise retain SIGKILL escalation
        // and poll until the finite deadline, which reports terminated=false.
        if (isGroupGone()) {
          settleTimeout(true);
          return;
        }
        startGroupPoll();
        return;
      }
      // Non-timeout path (ticket #127): the worker exited on its own, so the
      // promise settles on the direct-child close without process-group
      // verification. Group-exit polling and the terminated flag apply to the
      // timeout path only; see the operator doc for the residual detached-
      // descendant risk on plain failures.
      settled = true;
      clearInterval(heartbeat);
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
      if (stdoutBuffer.text !== '') {
        const line = stripCarriageReturn(stdoutBuffer.text);
        stdout += `${line}\n`;
        handlers.onStdoutLine?.(line);
        if (options.stdoutLogFilter?.(line) ?? true) {
          console.log(`[${options.label}] ${line}`);
        }
      }
      if (stderrBuffer.text !== '') {
        const line = stripCarriageReturn(stderrBuffer.text);
        stderr += `${line}\n`;
        handlers.onStderrLine?.(line);
        console.error(`[${options.label}] ${line}`);
      }
      if (error !== null) {
        console.log(`[${options.label}] failed (spawn error)`);
        reject(error);
        return;
      }
      if (exitCode !== 0) {
        console.log(`[${options.label}] failed (exit ${String(exitCode)})`);
        reject(
          new Error(`${invocation} failed (exit ${String(exitCode)}): ${stderr.slice(-2000)}`),
        );
        return;
      }
      console.log(`[${options.label}] completed (exit 0)`);
      resolve({ stdout, stderr });
    };

    child.stdout?.on('data', (chunk: Buffer | string) => {
      lastActivity = now();
      pushChunk(stdoutBuffer, String(chunk), (line) => {
        stdout += `${line}\n`;
        handlers.onStdoutLine?.(line);
        if (options.stdoutLogFilter?.(line) ?? true) {
          console.log(`[${options.label}] ${line}`);
        }
      });
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      lastActivity = now();
      pushChunk(stderrBuffer, String(chunk), (line) => {
        stderr += `${line}\n`;
        handlers.onStderrLine?.(line);
        console.error(`[${options.label}] ${line}`);
      });
    });
    child.on('close', (code: number | null) => {
      finish(null, code ?? 0);
    });
    child.on('error', (error: Error) => {
      finish(error, null);
    });
  });
}
