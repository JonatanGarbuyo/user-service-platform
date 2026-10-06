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
} from './skill-evidence.js';
import type { CommandExecutor } from './runner.js';

export const SKILL_EVIDENCE_PATH_MESSAGE_PREFIX = 'Skill evidence:';

// Explicit bound for the read-only session-export traversal (ticket #116):
// an export that never returns becomes an honest export failure, never a
// hung evidence step. The worker's own watchdog bound still owns the worker.
export const SESSION_EXPORT_TIMEOUT_MS = 60_000;

// Capture bounds: streamed worker output is unbounded, so evidence keeps a
// bounded prefix of complete lines plus a bounded trailing fragment.
export const MAX_CAPTURED_LINES = 5000;
export const MAX_CAPTURED_LINE_LENGTH = 64_000;

export function formatEvidencePathMessage(latestPath: string): string {
  return `${SKILL_EVIDENCE_PATH_MESSAGE_PREFIX} ${latestPath}`;
}

// Workers emit real JSON tool records with `--format json` on the pinned
// CLI. The flag is additive: frontmatter model/agent resolution, permissions
// and live streaming behavior are unchanged.
export function withJsonFormat(args: readonly string[]): string[] {
  if (args.includes('--format')) {
    return [...args];
  }
  return [...args, '--format', 'json'];
}

export interface EvidenceCapture {
  lines: string[];
  pushLine: (line: string) => void;
  pushChunk: (chunk: string) => void;
  wasTruncated: () => boolean;
}

export function createEvidenceCapture(): EvidenceCapture {
  const lines: string[] = [];
  let trailing = '';
  let truncated = false;
  const pushLine = (line: string): void => {
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
    pushChunk: (chunk: string): void => {
      trailing += chunk.slice(0, MAX_CAPTURED_LINE_LENGTH);
      if (trailing.length > MAX_CAPTURED_LINE_LENGTH * 2) {
        trailing = trailing.slice(-MAX_CAPTURED_LINE_LENGTH);
        truncated = true;
      }
      let index = trailing.indexOf('\n');
      while (index >= 0) {
        pushLine(trailing.slice(0, index));
        trailing = trailing.slice(index + 1);
        index = trailing.indexOf('\n');
      }
    },
  };
}

export type SessionExporter = (sessionId: string) => Promise<SessionExportInput | null>;

export function commandSessionExporter(execute: CommandExecutor): SessionExporter {
  return async (sessionId: string): Promise<SessionExportInput | null> => {
    const timeout = new Promise<null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, SESSION_EXPORT_TIMEOUT_MS);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    });
    const fetched = (async (): Promise<SessionExportInput | null> => {
      try {
        const { stdout } = await execute('opencode', ['export', sessionId]);
        const parsed: unknown = JSON.parse(stdout) as unknown;
        if (typeof parsed !== 'object' || parsed === null) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    })();
    return Promise.race([fetched, timeout]);
  };
}

export interface EvidenceInvocationInput {
  command: string;
  axis: string;
  attempt?: number;
  workerStartHead: string;
  env?: NodeJS.ProcessEnv;
}

export function buildEvidenceInvocation(input: EvidenceInvocationInput): SkillEvidenceInvocation {
  const attribution = readGitHubAttribution(input.env ?? process.env);
  return {
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
  if (collected.truncated) {
    exportFailures.push('primary stream truncated at bound');
  }
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
