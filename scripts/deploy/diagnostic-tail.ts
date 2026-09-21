// Bounded sandbox smoke diagnostics (ticket #96, ADR-0009).
//
// The Worker already emits a redacted `session.resolve-failed` event with a
// stable `phase` (`config`|`auth`|`session`) plus safe correlation metadata
// only (ticket #93). GitHub Actions sees just the smoke HTTP response, so a
// failing anonymous `GET /v1/me` cannot be attributed without opening
// Cloudflare logs manually. This module is the whitelist boundary that makes
// the sandbox deploy/smoke evidence self-contained:
//
// - `buildSessionFailureTailArgs` invokes the existing Cloudflare/Wrangler
//   credentials through `wrangler tail <worker> --format json --search
//   session.resolve-failed` (streaming only; no historical query).
// - `parseTailLine`/`parseTailLines` accept only the already-redacted event
//   and return only whitelisted fields (`event`, `phase`, optional `requestId`
//   / `environment`). Exception text, cookies, credentials, tokens, email
//   addresses, action URLs and request bodies never surface.
// - `summarizeSessionFailures` renders the safe phase (or `phase
//   unavailable` when nothing matched) without dumping unfiltered logs.
//
// `wrangler tail --format json` streams one JSON envelope per invocation
// (`{ outcome, logs: [{ message, level }], ... }`) where each `console.log`
// string sits inside `logs[].message`. Pretty-printed envelopes may span
// several lines, so `parseTailLines` splits brace-balanced JSON documents
// before matching; it never executes or reprints raw tail output.
//
// This is release/operations tooling, not Identity business behavior: no
// public endpoint changes, no sandbox-only Identity branch, no D1 access.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { ResolvedDeployment } from './targets.js';

// Stable session-resolution failure phases (ticket #93). Kept in sync with
// `SessionResolvePhase` in `src/features/identity/session.ts`; the tail
// parser accepts exactly these values and rejects everything else.
export type SessionFailurePhase = 'config' | 'auth' | 'session';

// Whitelisted safe diagnostic event. Only these fields may reach the GitHub
// Actions log.
export interface SafeSessionFailure {
  readonly event: 'session.resolve-failed';
  readonly phase: SessionFailurePhase;
  readonly requestId?: string;
  readonly environment?: string;
}

// Bounds for the diagnostic tail lifecycle (tickets #96/#98, acceptance 5).
// The tail streams for the smoke window only: startup waits a bounded
// readiness grace so the tail connects before the fast health -> anonymous
// `/v1/me` smoke sequence, a hard maximum guarantees the child can never
// linger, and `stop()` escalates SIGTERM -> SIGKILL within
// `STOP + KILL_SETTLE` (well inside the hard maximum) while always releasing
// stdio handles so the deploy process can exit.
export const SESSION_FAILURE_TAIL_START_TIMEOUT_MS = 15_000;
export const SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS = 10_000;
export const SESSION_FAILURE_TAIL_MAX_DURATION_MS = 300_000;
// Bounded grace between spawn and startup resolution (ticket #98, AC6).
// Wrangler `tail` exposes no machine-readable readiness signal — connection
// chatter is human text on stderr, which this boundary deliberately discards
// unfiltered — so startup waits this fixed grace instead of racing the smoke.
// Kept well inside the start timeout.
export const SESSION_FAILURE_TAIL_READY_GRACE_MS = 5_000;
// Settle window after the SIGKILL escalation before `stop()` (and the hard
// maximum) destroys stdio handles unconditionally. The configured stop bound
// is therefore the composite `STOP_TIMEOUT + KILL_SETTLE` (worst case 15s),
// still far below the hard maximum.
export const SESSION_FAILURE_TAIL_KILL_SETTLE_MS = 5_000;

const SESSION_FAILURE_EVENT = 'session.resolve-failed';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSessionFailurePhase(value: unknown): value is SessionFailurePhase {
  return value === 'config' || value === 'auth' || value === 'session';
}

function cleanCorrelation(value: unknown): string | undefined {
  // Correlation passes through verbatim: its safety is guaranteed upstream by
  // the #93 redacted telemetry contract (level/event/phase plus safe metadata
  // only — no credentials, tokens, cookies, emails, or URLs), which
  // `src/features/identity/session.test.ts` pins. This boundary only decides
  // which keys may surface, never re-scrubs trusted values.
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Pure boundary mapper: any parsed JSON value becomes either the whitelisted
// safe event or null. Unknown keys (exception text, cookies, credentials,
// tokens, emails, URLs, bodies) are dropped by construction — the result is
// rebuilt from the validated fields only.
export function extractSafeSessionFailure(value: unknown): SafeSessionFailure | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.event !== SESSION_FAILURE_EVENT) {
    return null;
  }
  if (!isSessionFailurePhase(value.phase)) {
    return null;
  }
  const requestId = cleanCorrelation(value.requestId);
  const environment = cleanCorrelation(value.environment);
  return {
    event: SESSION_FAILURE_EVENT,
    phase: value.phase,
    ...(requestId === undefined ? {} : { requestId }),
    ...(environment === undefined ? {} : { environment }),
  };
}

function extractFromMessageCandidate(candidate: unknown): SafeSessionFailure | null {
  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (text.length === 0) {
      return null;
    }
    try {
      return extractSafeSessionFailure(JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  }
  return extractSafeSessionFailure(candidate);
}

// Matches one parsed tail document: either the direct redacted Worker log or
// a `wrangler tail --format json` invocation envelope whose `logs[].message`
// entries carry the redacted log string.
function extractFromDocument(document: unknown): SafeSessionFailure | null {
  const direct = extractSafeSessionFailure(document);
  if (direct !== null) {
    return direct;
  }
  if (!isRecord(document)) {
    return null;
  }
  const logs = document.logs;
  if (!Array.isArray(logs)) {
    return null;
  }
  for (const entry of logs) {
    if (!isRecord(entry)) {
      continue;
    }
    const message = entry.message;
    const candidates = Array.isArray(message) ? message : [message];
    for (const candidate of candidates) {
      const found = extractFromMessageCandidate(candidate);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

// Parses a single JSON tail line/document. Returns null for non-JSON,
// non-matching envelopes, unknown phases, or anything outside the whitelist.
export function parseTailLine(line: string): SafeSessionFailure | null {
  if (line.trim().length === 0) {
    return null;
  }
  try {
    return extractFromDocument(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

// Splits streamed tail text into brace-balanced JSON documents so both
// single-line (NDJSON) and pretty-printed multi-line envelopes are handled
// without ever reprinting raw content.
function splitJsonDocuments(text: string): string[] {
  const documents: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        documents.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return documents;
}

// Collects every safe event from a tail window. Unmatched lines (smoke step
// logs, other invocations, garbage) are ignored; absence of a match is a
// normal empty result, never an error.
export function parseTailLines(lines: readonly string[]): SafeSessionFailure[] {
  const events: SafeSessionFailure[] = [];
  for (const document of splitJsonDocuments(lines.join('\n'))) {
    const found = parseTailLine(document);
    if (found !== null) {
      events.push(found);
    }
  }
  return events;
}

// Renders exactly the whitelisted fields; rebuilding the object guarantees no
// extra key can leak even if the input carries secrets.
export function formatSafeSessionFailure(event: SafeSessionFailure): string {
  return JSON.stringify({
    event: event.event,
    phase: event.phase,
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(event.environment === undefined ? {} : { environment: event.environment }),
  });
}

// Human-readable GitHub Actions summary. Empty input reports `phase
// unavailable` (a successful smoke treats this as normal; a failed smoke
// reports it instead of dumping unfiltered logs). Non-empty input names the
// distinct stable phases plus one whitelisted JSON line per event.
export function summarizeSessionFailures(events: readonly SafeSessionFailure[]): string {
  if (events.length === 0) {
    return (
      'sandbox smoke diagnostic: session failure phase unavailable ' +
      '(no session.resolve-failed event observed)'
    );
  }
  const phases = [...new Set(events.map((entry) => entry.phase))];
  const label =
    phases.length === 1 ? `phase=${phases[0] ?? 'unknown'}` : `phases=${phases.join('|')}`;
  const details = events.map((entry) => formatSafeSessionFailure(entry)).join('\n');
  return (
    `sandbox smoke diagnostic: session.resolve-failed ${label} ` +
    `(${String(events.length)} event(s))\n${details}`
  );
}

// Resolves the repository-pinned Wrangler CLI entry
// (`wrangler-dist/cli.js`) through the installed `wrangler` package metadata.
// Spawning this file with `process.execPath` runs Wrangler in the child
// directly: unlike `npx wrangler` (or `node_modules/.bin/wrangler`, whose
// `bin/wrangler.js` wrapper spawns `wrangler-dist/cli.js` with inherited
// stdio), there is no intermediate wrapper/descendant process that can
// outlive `stop()` while holding the captured pipes open (ticket #98, AC1).
export function resolveWranglerCliPath(): string {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('wrangler/package.json');
  return join(dirname(packagePath), 'wrangler-dist', 'cli.js');
}

// `wrangler tail` invocation for the sandbox smoke window (ticket #96). Uses
// only the Worker name plus the target-specific Wrangler config; credentials
// arrive through the existing process environment and no secret, email, or
// token value is embedded in the arguments. These are Wrangler-native
// arguments: the caller prefixes them with the pinned CLI entry (see
// `buildSessionFailureTailCommand`) instead of routing through `npx`.
export function buildSessionFailureTailArgs(
  resolved: Pick<ResolvedDeployment, 'workerName'>,
  configPath: string,
): string[] {
  return [
    'tail',
    resolved.workerName,
    '--format',
    'json',
    '--search',
    SESSION_FAILURE_EVENT,
    '--config',
    configPath,
  ];
}

// Fully resolved tail invocation: the current Node executable plus the pinned
// Wrangler CLI entry plus the filtered `tail` arguments (ticket #98, AC1).
export interface SessionFailureTailCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function buildSessionFailureTailCommand(
  resolved: Pick<ResolvedDeployment, 'workerName'>,
  configPath: string,
  cliPath: string = resolveWranglerCliPath(),
): SessionFailureTailCommand {
  return {
    command: process.execPath,
    args: [cliPath, ...buildSessionFailureTailArgs(resolved, configPath)],
  };
}

// Handle for one bounded tail window. `stop` terminates the tail (bounded by
// `SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS`) and resolves with the raw captured
// lines; the deploy boundary parses/whitelists them before logging anything.
export interface SessionFailureTailHandle {
  readonly stop: () => Promise<readonly string[]>;
}

// Rejects when `promise` does not settle within `timeoutMs` so tail
// startup/collection/termination can never hang CI (ticket #96, acceptance 5).
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${String(timeoutMs)}ms.`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function killIfAlive(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch {
      // Kill failures fall through to the stop-timeout force-kill.
    }
  }
}

// Process factory seam for the tail lifecycle. Defaults to `node:child_process`
// `spawn`; tests inject a wrapper around the real `spawn` to capture the
// requested invocation or drive stub children with short bounds.
export type SessionFailureTailSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

// Overrides for the tail lifecycle, used by tests to prove bounded
// termination with stub children and short bounds. Production callers omit
// this entirely and receive the pinned Wrangler invocation with the
// documented default bounds.
export interface SessionFailureTailOptions {
  readonly spawnFn?: SessionFailureTailSpawn;
  // Stub command/args replace the pinned Wrangler invocation (tests only).
  readonly command?: string;
  readonly args?: readonly string[];
  // Pinned CLI entry override; defaults to `resolveWranglerCliPath()`.
  readonly wranglerCliPath?: string;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly killSettleMs?: number;
  readonly maxDurationMs?: number;
  readonly readyGraceMs?: number;
}

// Bounded `wrangler tail` for the sandbox smoke window (tickets #96/#98).
//
// Spawns the repository-pinned `wrangler-dist/cli.js` directly under
// `process.execPath` with the target-specific Wrangler config so the smoke
// window captures only the already-redacted `session.resolve-failed` Worker
// event. Cloudflare credentials arrive through process inheritance only; raw
// tail output is kept in memory and never printed — the deploy boundary
// parses and whitelists it before logging anything. Stderr is consumed and
// discarded so unfiltered Worker output can never reach the Actions log
// through this pipe.
//
// Lifecycle (ticket #98): the spawned CLI process is the actual controlled
// child — no `npx`/wrapper hop, so no descendant can outlive `stop()` while
// holding the pipes. Startup waits the bounded readiness grace (no usable
// Wrangler readiness signal exists; stderr chatter stays private) inside the
// start timeout so a hung spawn can never stall the deploy. A hard maximum
// escalates SIGTERM -> SIGKILL and then releases stdio even when `stop()` is
// never reached. `stop()` is idempotent, escalates SIGTERM -> SIGKILL within
// `stopTimeout + killSettle`, flushes remaining buffered output, destroys both
// stdio streams, and unrefs the child so the deploy process can always exit.
export function startSessionFailureTail(
  resolved: Pick<ResolvedDeployment, 'workerName'>,
  configPath: string,
  options: SessionFailureTailOptions = {},
): Promise<SessionFailureTailHandle> {
  const startTimeoutMs = options.startTimeoutMs ?? SESSION_FAILURE_TAIL_START_TIMEOUT_MS;
  const stopTimeoutMs = options.stopTimeoutMs ?? SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS;
  const killSettleMs = options.killSettleMs ?? SESSION_FAILURE_TAIL_KILL_SETTLE_MS;
  const maxDurationMs = options.maxDurationMs ?? SESSION_FAILURE_TAIL_MAX_DURATION_MS;
  const readyGraceMs = options.readyGraceMs ?? SESSION_FAILURE_TAIL_READY_GRACE_MS;
  const spawnFn: SessionFailureTailSpawn = options.spawnFn ?? spawn;

  const startup = async (): Promise<SessionFailureTailHandle> => {
    const tailCommand =
      options.command !== undefined || options.args !== undefined
        ? { command: options.command ?? process.execPath, args: options.args ?? [] }
        : buildSessionFailureTailCommand(resolved, configPath, options.wranglerCliPath);
    const child: ChildProcess = spawnFn(tailCommand.command, [...tailCommand.args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Never hold the deploy loop open on the child's behalf: explicit
    // SIGTERM/SIGKILL escalation plus stream destruction below owns
    // termination; unref keeps a wedged child from pinning process exit.
    if (typeof child.unref === 'function') {
      child.unref();
    }
    const lines: string[] = [];
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
    // Discard stderr: tail connection chatter must never surface unfiltered.
    child.stderr?.resume();

    let spawnError: Error | undefined;
    const onSpawnError = (error: Error): void => {
      spawnError = error;
    };
    child.once('error', onSpawnError);

    const releaseStreams = (): void => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      try {
        child.stdout?.destroy();
      } catch {
        // Stream teardown never fails termination.
      }
      try {
        child.stderr?.destroy();
      } catch {
        // Stream teardown never fails termination.
      }
    };

    const flushBuffer = (): void => {
      if (buffer.length > 0) {
        lines.push(buffer);
        buffer = '';
      }
    };

    const waitForExit = (): Promise<void> =>
      new Promise<void>((resolvePromise) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolvePromise();
          return;
        }
        const onSettled = (): void => {
          child.removeListener('close', onSettled);
          child.removeListener('error', onSettled);
          resolvePromise();
        };
        child.once('close', onSettled);
        child.once('error', onSettled);
      });

    const waitForExitBounded = async (timeoutMs: number): Promise<boolean> => {
      try {
        await withTimeout(waitForExit(), timeoutMs, 'diagnostic tail stop');
        return true;
      } catch {
        return false;
      }
    };

    let stopped = false;
    let maxKillTimer: ReturnType<typeof setTimeout> | undefined;
    let maxReleaseTimer: ReturnType<typeof setTimeout> | undefined;
    const clearMaxTimers = (): void => {
      if (maxKillTimer !== undefined) {
        clearTimeout(maxKillTimer);
        maxKillTimer = undefined;
      }
      if (maxReleaseTimer !== undefined) {
        clearTimeout(maxReleaseTimer);
        maxReleaseTimer = undefined;
      }
    };

    // Hard maximum: terminates the tail even when `stop()` is never called
    // (ticket #98, AC3). SIGTERM first; escalate to SIGKILL after the stop
    // bound; release stdio after the kill settle so a SIGTERM-ignoring child
    // can neither survive nor pin the deploy loop via open pipes.
    const maxTimer = setTimeout(() => {
      if (stopped) {
        return;
      }
      killIfAlive(child, 'SIGTERM');
      maxKillTimer = setTimeout(() => {
        if (stopped) {
          return;
        }
        killIfAlive(child, 'SIGKILL');
        maxReleaseTimer = setTimeout(() => {
          if (stopped) {
            return;
          }
          flushBuffer();
          releaseStreams();
        }, killSettleMs);
        if (typeof maxReleaseTimer.unref === 'function') {
          maxReleaseTimer.unref();
        }
      }, stopTimeoutMs);
      if (typeof maxKillTimer.unref === 'function') {
        maxKillTimer.unref();
      }
    }, maxDurationMs);
    if (typeof maxTimer.unref === 'function') {
      maxTimer.unref();
    }

    let stopPromise: Promise<readonly string[]> | undefined;
    const stop = (): Promise<readonly string[]> => {
      stopPromise ??= (async (): Promise<readonly string[]> => {
        stopped = true;
        clearTimeout(maxTimer);
        clearMaxTimers();
        killIfAlive(child, 'SIGTERM');
        const exited = await waitForExitBounded(stopTimeoutMs);
        if (!exited) {
          killIfAlive(child, 'SIGKILL');
          await waitForExitBounded(killSettleMs);
        }
        flushBuffer();
        releaseStreams();
        return [...lines];
      })();
      return stopPromise;
    };

    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(() => {
        resolvePromise();
      }, readyGraceMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
    child.removeListener('error', onSpawnError);
    if (spawnError !== undefined) {
      stopped = true;
      clearTimeout(maxTimer);
      clearMaxTimers();
      releaseStreams();
      throw new Error(`diagnostic tail failed to start: ${spawnError.message}`);
    }
    return { stop };
  };
  return withTimeout(startup(), startTimeoutMs, 'diagnostic tail start');
}
