// Evidence-capable worker seam for attributable skill evidence (ticket #116).
//
// Wraps the existing worker stream/executor seams additively: live output,
// heartbeats, watchdog bounds and the original exit/timeout are preserved.
// Skill evidence is collected best-effort from real JSON tool records already
// present on stdout plus bounded read-only session exports, then persisted to
// repository-ignored evidence paths. Telemetry diagnostics are separate from
// READY, reviewer markers, gates and exact-HEAD CI: persistence failures and
// incomplete coverage never change the worker outcome.

import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  buildSkillEvidence,
  collectPrimaryToolCalls,
  discoverChildSessionIds,
  evidenceFileName,
  readGitHubAttribution,
  serializeSkillEvidence,
  SKILL_EVIDENCE_DIR,
  type SessionExportInput,
  type SkillEvidenceInvocation,
  type SkillEvidenceRecord,
  type SkillEvidenceWorker,
} from './skill-evidence.js';
import { runBoundedCommand, withJsonFormat, type CommandExecutor } from './runner.js';

export const SKILL_EVIDENCE_PATH_MESSAGE_PREFIX = 'Skill evidence:';

// Explicit bound for the read-only session-export traversal (ticket #116):
// an export that never returns becomes an honest export failure, never a
// hung evidence step. The worker's own watchdog bound still owns the worker.
export const SESSION_EXPORT_TIMEOUT_MS = 60_000;

// Output-size bound for a single session export: exports larger than this are
// truncated before parsing (which then yields an honest export failure
// instead of unbounded memory growth).
export const SESSION_EXPORT_MAX_BYTES = 5 * 1024 * 1024;

// Capture bounds: streamed worker output is unbounded, so evidence keeps a
// bounded prefix of complete lines plus a bounded trailing fragment.
export const MAX_CAPTURED_LINES = 5000;
export const MAX_CAPTURED_LINE_LENGTH = 64_000;

export function formatEvidencePathMessage(latestPath: string): string {
  return `${SKILL_EVIDENCE_PATH_MESSAGE_PREFIX} ${latestPath}`;
}

// `withJsonFormat` is the single additive `--format json` seam for shipped
// worker builders in `runner.ts`/`ticket-flow.ts`. Re-exported here so
// existing evidence-worker imports keep working on the same production path.
export { withJsonFormat };

export interface EvidenceCapture {
  lines: string[];
  pushLine: (line: string) => void;
  wasTruncated: () => boolean;
}

export function createEvidenceCapture(): EvidenceCapture {
  const lines: string[] = [];
  let truncated = false;
  const pushLine = (line: string): void => {
    if (line.length > MAX_CAPTURED_LINE_LENGTH) {
      truncated = true;
    }
    if (lines.length < MAX_CAPTURED_LINES) {
      lines.push(line.slice(0, MAX_CAPTURED_LINE_LENGTH));
    } else {
      truncated = true;
    }
  };
  return {
    lines,
    pushLine,
    wasTruncated: () => truncated,
  };
}

export type SessionExporter = (sessionId: string) => Promise<SessionExportInput | null>;

export interface SessionExportBounds {
  timeoutMs?: number;
  maxBytes?: number;
}

// Structured `--format json` worker event lines (ticket #116) carry raw tool
// parts, model text, reasoning and tool output. Evidence-enabled workers
// capture these lines but must not echo them to the console: pass
// `suppressJsonWorkerLines` as `stdoutLogFilter` so only unstructured
// lifecycle/progress lines are logged while every line is still captured.
const JSON_WORKER_EVENT_TYPES = new Set([
  'tool_use',
  'text',
  'reasoning',
  'step_start',
  'step_finish',
  'error',
]);

export function isJsonWorkerEventLine(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const type = (parsed as Record<string, unknown>).type;
  return typeof type === 'string' && JSON_WORKER_EVENT_TYPES.has(type);
}

export function suppressJsonWorkerLines(line: string): boolean {
  return !isJsonWorkerEventLine(line);
}

export function commandSessionExporter(
  execute: CommandExecutor = (command, args) =>
    runBoundedCommand(command, args, {
      timeoutMs: SESSION_EXPORT_TIMEOUT_MS,
      maxBufferBytes: SESSION_EXPORT_MAX_BYTES,
    }),
  bounds: SessionExportBounds = {},
): SessionExporter {
  const timeoutMs = bounds.timeoutMs ?? SESSION_EXPORT_TIMEOUT_MS;
  const maxBytes = bounds.maxBytes ?? SESSION_EXPORT_MAX_BYTES;
  return async (sessionId: string): Promise<SessionExportInput | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
    // The default executor terminates the export child on timeout and caps
    // output; the race backstop additionally bounds injectable executors.
    // Either way the timer is always cleaned up and no payload is logged:
    // diagnostics stay fixed metadata-only strings at the caller.
    const fetched = (async (): Promise<SessionExportInput | null> => {
      try {
        const { stdout } = await execute('opencode', ['export', sessionId]);
        const bounded = stdout.length > maxBytes ? stdout.slice(0, maxBytes) : stdout;
        const parsed: unknown = JSON.parse(bounded) as unknown;
        if (typeof parsed !== 'object' || parsed === null) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    })();
    const result = await Promise.race([fetched, timeout]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    return result;
  };
}

export interface EvidenceInvocationInput {
  worker: SkillEvidenceWorker;
  command: string;
  axis: string;
  attempt?: number;
  workerStartHead: string;
  env?: NodeJS.ProcessEnv;
}

export function buildEvidenceInvocation(input: EvidenceInvocationInput): SkillEvidenceInvocation {
  const attribution = readGitHubAttribution(input.env ?? process.env);
  return {
    worker: input.worker,
    command: input.command,
    axis: input.axis,
    attempt: input.attempt ?? 1,
    workerStartHead: input.workerStartHead,
    githubRunId: attribution.runId,
    githubRunAttempt: attribution.runAttempt,
    githubJobName: attribution.jobName,
  };
}

export function primarySessionIdFromLines(lines: readonly string[]): string | null {
  const bounded = lines.slice(0, MAX_CAPTURED_LINES);
  for (const line of bounded) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.type !== 'tool_use') {
      continue;
    }
    const sessionId = record.sessionID;
    if (typeof sessionId === 'string' && sessionId.trim() !== '') {
      return sessionId.trim();
    }
    const part = record.part;
    if (typeof part === 'object' && part !== null && !Array.isArray(part)) {
      const partSession = (part as Record<string, unknown>).sessionID;
      if (typeof partSession === 'string' && partSession.trim() !== '') {
        return partSession.trim();
      }
    }
  }
  return null;
}

export interface PersistEvidenceDeps {
  mkdir?: (dir: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (path: string, contents: string) => Promise<unknown>;
  dir?: string;
  now?: () => string;
}

export async function persistSkillEvidence(
  record: SkillEvidenceRecord,
  deps: PersistEvidenceDeps = {},
): Promise<{ evidencePath: string; latestPath: string }> {
  const dir = deps.dir ?? SKILL_EVIDENCE_DIR;
  const mkdir =
    deps.mkdir ?? ((path: string, options: { recursive: boolean }) => fs.mkdir(path, options));
  const writeFile =
    deps.writeFile ?? ((path: string, contents: string) => fs.writeFile(path, contents, 'utf8'));
  const contents = serializeSkillEvidence(record);
  const evidencePath = `${dir}/${evidenceFileName(record.invocation)}`;
  // Shared latest snapshot mirrors the run-summary convention so existing
  // artifact/download flows keep working; per-invocation files preserve
  // distinct retries and concurrent axes.
  const latestPath = `${dir}/latest.json`;
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, contents);
  await writeFile(latestPath, contents);
  return { evidencePath, latestPath };
}

export interface FinalizeEvidenceInput {
  invocation: SkillEvidenceInvocation;
  lines: readonly string[];
  exporter?: SessionExporter;
  exportFailures?: readonly string[];
  truncatedStream?: boolean;
  worktreeRoot?: string;
}

export interface FinalizeEvidenceResult {
  record: SkillEvidenceRecord;
  evidencePath?: string;
  diagnostic: string;
}

// Persists useful minimal evidence on success, error and timeout
// finalization without masking the original exit or timeout. All failures
// are best-effort: the caller always keeps its own outcome.
export async function finalizeSkillEvidence(
  input: FinalizeEvidenceInput,
  deps: PersistEvidenceDeps = {},
): Promise<FinalizeEvidenceResult> {
  const primarySessionId = primarySessionIdFromLines(input.lines);
  const collected = collectPrimaryToolCalls(input.lines);
  const discovered = discoverChildSessionIds(collected.calls, primarySessionId);
  const childExports: Record<string, SessionExportInput | null> = {};
  const exportFailures: string[] = [...(input.exportFailures ?? [])];
  // Truncation reasons are single-sourced in `buildSkillEvidence` (which
  // re-examines the same lines plus `truncatedStream`): pushing the same
  // reason here would persist it twice. `collected`/`discovered` above stay
  // only to know which verified child exports to fetch before building.
  if (input.exporter !== undefined) {
    for (const childId of discovered.childIds) {
      try {
        const exported = await input.exporter(childId);
        childExports[childId] = exported;
        if (exported === null) {
          exportFailures.push(`missing export for session ${childId}`);
        }
      } catch {
        childExports[childId] = null;
        exportFailures.push(`export failed for session ${childId}`);
      }
    }
  } else {
    for (const childId of discovered.childIds) {
      childExports[childId] = null;
      exportFailures.push(`export unavailable for session ${childId}`);
    }
  }
  const record = buildSkillEvidence({
    invocation: input.invocation,
    primaryLines: input.lines,
    primarySessionId,
    childExports,
    exportFailures,
    truncatedStream: input.truncatedStream,
    ...(input.worktreeRoot === undefined ? {} : { worktreeRoot: input.worktreeRoot }),
  });
  try {
    const { evidencePath } = await persistSkillEvidence(record, deps);
    const diagnostic =
      `skill evidence ${record.coverage.status}: ` +
      `${String(record.events.length)} events, ` +
      `${String(record.coverage.childSessionIds.length)} children`;
    console.log(formatEvidencePathMessage(evidencePath));
    return { record, evidencePath, diagnostic };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Skill evidence persistence failed: ${detail}`);
    return { record, diagnostic: `skill evidence persistence failed: ${detail}` };
  }
}
