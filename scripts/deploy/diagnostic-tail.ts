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
import { spawn, type ChildProcess } from 'node:child_process';
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

// Bounds for the diagnostic tail lifecycle (ticket #96, acceptance 5). The
// tail streams for the smoke window only: startup resolves without waiting
// for the first line, a hard maximum guarantees the child can never linger,
// and `stop()` waits only up to `STOP` before force-killing.
export const SESSION_FAILURE_TAIL_START_TIMEOUT_MS = 15_000;
export const SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS = 10_000;
export const SESSION_FAILURE_TAIL_MAX_DURATION_MS = 300_000;

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

// `wrangler tail` invocation for the sandbox smoke window (ticket #96). Uses
// only the Worker name plus the target-specific Wrangler config; credentials
// arrive through the existing process environment and no secret, email, or
// token value is embedded in the arguments.
export function buildSessionFailureTailArgs(
  resolved: Pick<ResolvedDeployment, 'workerName'>,
  configPath: string,
): string[] {
  return [
    'wrangler',
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

// Bounded `wrangler tail` for the sandbox smoke window (ticket #96).
//
// Spawns `wrangler tail <worker> --format json --search session.resolve-failed`
// with the target-specific Wrangler config so the smoke window captures only
// the already-redacted `session.resolve-failed` Worker event. Cloudflare
// credentials arrive through process inheritance only; raw tail output is
// kept in memory and never printed — the deploy boundary parses and
// whitelists it before logging anything. Stderr is consumed and discarded so
// unfiltered Worker output can never reach the Actions log through this pipe.
//
// Bounds: startup resolves once the child is spawned (tail streams, so there
// is no ready signal to wait for) inside `SESSION_FAILURE_TAIL_START_TIMEOUT_MS`
// so a hung spawn can never stall the deploy; a hard maximum kills a tail
// whose `stop` is never reached; `stop` waits only up to the stop timeout
// before force-killing.
export function startSessionFailureTail(
  resolved: Pick<ResolvedDeployment, 'workerName'>,
  configPath: string,
): Promise<SessionFailureTailHandle> {
  const startup = ((): Promise<SessionFailureTailHandle> => {
    const tailArgs = buildSessionFailureTailArgs(resolved, configPath);
    const child: ChildProcess = spawn('npx', tailArgs, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    const maxTimer = setTimeout(() => {
      killIfAlive(child, 'SIGTERM');
    }, SESSION_FAILURE_TAIL_MAX_DURATION_MS);
    if (typeof maxTimer.unref === 'function') {
      maxTimer.unref();
    }
    let stopped = false;
    const stop = async (): Promise<readonly string[]> => {
      if (stopped) {
        return [...lines];
      }
      stopped = true;
      clearTimeout(maxTimer);
      killIfAlive(child, 'SIGTERM');
      const closed = new Promise<void>((resolvePromise) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolvePromise();
          return;
        }
        child.once('close', () => {
          resolvePromise();
        });
        child.once('error', () => {
          resolvePromise();
        });
      });
      try {
        await withTimeout(closed, SESSION_FAILURE_TAIL_STOP_TIMEOUT_MS, 'diagnostic tail stop');
      } catch {
        killIfAlive(child, 'SIGKILL');
      }
      if (buffer.length > 0) {
        lines.push(buffer);
        buffer = '';
      }
      return [...lines];
    };
    return Promise.resolve({ stop });
  })();
  return withTimeout(startup, SESSION_FAILURE_TAIL_START_TIMEOUT_MS, 'diagnostic tail start');
}
