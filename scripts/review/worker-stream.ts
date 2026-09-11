import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

export interface StreamHandlers {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface WorkerStreamOptions {
  label: string;
  heartbeatMs?: number;
  now?: () => number;
}

export type SpawnFn = (command: string, args: readonly string[]) => SpawnedWorker;

// Minimal structural seam over the spawned worker: the real `spawn()` result
// satisfies this, and tests inject EventEmitters without real subprocesses.
export interface SpawnedWorker extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
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
  spawnFn: SpawnFn = (cmd, argv) => spawn(cmd, [...argv], { stdio: ['ignore', 'pipe', 'pipe'] }),
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

    const finish = (error: Error | null, exitCode: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(heartbeat);
      if (stdoutBuffer.text !== '') {
        const line = stripCarriageReturn(stdoutBuffer.text);
        stdout += `${line}\n`;
        handlers.onStdoutLine?.(line);
        console.log(`[${options.label}] ${line}`);
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
        console.log(`[${options.label}] ${line}`);
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
