// Attributable skill-tool evidence for remote OpenCode workers (ticket #116).
//
// The pinned OpenCode 1.18.30 CLI streams primary-session tool records as
// JSON lines (`opencode run --format json`) but filters `message.part.updated`
// to the primary session (`part.sessionID !== sessionID` continues before
// emit). Child (subagent) tool records are therefore recovered only through
// read-only exports of explicit child IDs discovered in harness-owned task
// metadata, after verifying `export.info.parentID`.
//
// This module normalizes real CLI/export tool records in memory through
// deterministic repository code. Raw exports and raw JSON payloads are never
// persisted or printed. Only bounded whitelisted metadata (identifiers,
// timestamps, statuses, validated skill names/paths, coverage and
// demonstrated source provenance) reaches evidence artifacts. Prompts, model
// text, tool output, grep/diff/list output, shell commands, test messages,
// arbitrary arguments, transcripts, reasoning, environment values and secrets
// are never sources of skill calls and never appear in evidence.

export const SKILL_EVIDENCE_VERSION = 1 as const;
export const SKILL_EVIDENCE_DIR = '.agent-ticket/skill-evidence';
export const SKILL_EVIDENCE_SUMMARY = '.agent-ticket/skill-evidence.json';

// Explicit traversal bounds: missing/malformed/truncated streams, missing
// exports, incorrect parentage, absent identifiers and bound exhaustion
// produce honest incomplete/unavailable coverage, never fabricated zero use
// or complete coverage.
export const MAX_PRIMARY_TOOL_EVENTS = 500;
export const MAX_CHILD_SESSIONS = 10;
export const MAX_EVIDENCE_EVENTS = 1000;
export const MAX_SKILL_NAME_LENGTH = 64;

export type SkillEvidenceKind = 'skill-invocation' | 'skill-attempt' | 'skill-file-read';

export type SkillCoverageStatus = 'complete' | 'incomplete' | 'unavailable';

export interface SkillEvidenceInvocation {
  command: string;
  axis: string;
  attempt: number;
  workerStartHead: string;
  githubRunId: string;
  githubRunAttempt: string;
  githubJobName: string;
}

export interface SkillEvidenceEvent {
  id: string;
  kind: SkillEvidenceKind;
  skillName: string;
  skillPath: string | null;
  sessionId: string;
  messageId: string;
  callId: string;
  status: string;
  timestamp: string | null;
  readRange: string | null;
  readFullness: 'full' | 'partial' | 'unknown';
  sourceProvenance: 'verified-tool-metadata' | 'verified-repo-path' | 'unknown';
  collectionNote: string | null;
}

export interface SkillEvidenceCoverage {
  status: SkillCoverageStatus;
  primarySessionId: string | null;
  childSessionIds: string[];
  reasons: string[];
}

export interface SkillEvidenceRecord {
  version: typeof SKILL_EVIDENCE_VERSION;
  invocation: SkillEvidenceInvocation;
  sessionLineage: { primarySessionId: string | null; parentIds: string[] };
  events: SkillEvidenceEvent[];
  coverage: SkillEvidenceCoverage;
  collectedAt: string;
}

// Minimal structural shape of a pinned CLI JSON tool record. Only tool_use
// records with a structured `part` object are accepted; structured-looking
// JSON inside prompts, model text, tool output or test messages is never
// reparsed as a tool event.
export interface PinnedToolPart {
  id?: unknown;
  sessionID?: unknown;
  messageID?: unknown;
  type?: unknown;
  tool?: unknown;
  state?: unknown;
}

export interface PinnedToolRecord {
  type?: unknown;
  sessionID?: unknown;
  part?: unknown;
  timestamp?: unknown;
}

interface NormalizedToolCall {
  identity: string;
  sessionId: string;
  messageId: string;
  callId: string;
  tool: string;
  status: string;
  timestamp: string | null;
  skillName: string | null;
  skillDir: string | null;
  readPath: string | null;
  readOffset: number | null;
  readLimit: number | null;
  childSessionId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// Persisted identifiers stay bounded: evidence carries identity metadata,
// never content, so overlong values are truncated rather than stored.
const MAX_PERSISTED_ID_LENGTH = 256;

function asBoundedId(value: unknown): string | null {
  const text = asNonEmptyString(value);
  return text === null ? null : text.slice(0, MAX_PERSISTED_ID_LENGTH);
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normalizeSkillName(raw: unknown): string | null {
  const name = asNonEmptyString(raw);
  if (name === null || name.length > MAX_SKILL_NAME_LENGTH) {
    return null;
  }
  return SKILL_NAME_PATTERN.test(name) ? name : null;
}

const REPO_SKILL_PATH_PATTERN = /^\.agents\/skills\/([a-z0-9][a-z0-9-]{0,63})\/SKILL\.md$/;

export function skillNameFromRepoPath(raw: unknown): string | null {
  const path = asNonEmptyString(raw);
  if (path === null) {
    return null;
  }
  const normalized = path.replace(/^\.\//, '');
  const match = REPO_SKILL_PATH_PATTERN.exec(normalized);
  if (match?.[1] === undefined) {
    return null;
  }
  return normalizeSkillName(match[1]);
}

function readRangeOf(offset: number | null, limit: number | null): string | null {
  if (offset === null && limit === null) {
    return null;
  }
  const offsetText = offset === null ? '?' : String(offset);
  const limitText = limit === null ? '?' : String(limit);
  return `offset=${offsetText} limit=${limitText}`;
}

function toFiniteInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

// Accepts only genuine pinned CLI tool records. Returns null for prompts,
// model text, tool output, grep/diff/list output, shell commands, test
// messages, malformed/truncated JSON and any non-tool record. String fields
// are never reparsed for nested JSON.
export function parsePrimaryToolRecord(line: string): NormalizedToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record?.type !== 'tool_use') {
    return null;
  }
  const part = asRecord(record.part);
  if (part?.type !== 'tool') {
    return null;
  }
  const tool = asNonEmptyString(part.tool);
  if (tool === null) {
    return null;
  }
  if (tool !== 'skill' && tool !== 'read' && tool !== 'task') {
    return null;
  }
  const sessionId = asBoundedId(part.sessionID) ?? asBoundedId(record.sessionID);
  const messageId = asBoundedId(part.messageID);
  const callId = asBoundedId(part.id);
  if (sessionId === null || messageId === null || callId === null) {
    return null;
  }
  const state = asRecord(part.state);
  if (state === null) {
    return null;
  }
  const status = asNonEmptyString(state.status);
  if (status === null) {
    return null;
  }
  const timestamp =
    typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? new Date(record.timestamp).toISOString()
      : null;
  const input = asRecord(state.input);
  const metadata = asRecord(state.metadata);
  let skillName: string | null = null;
  let skillDir: string | null = null;
  let readPath: string | null = null;
  let readOffset: number | null = null;
  let readLimit: number | null = null;
  let childSessionId: string | null = null;
  if (tool === 'skill') {
    skillName = normalizeSkillName(input?.name);
    skillDir = asBoundedId(metadata?.dir);
  } else if (tool === 'read') {
    const rawPath = asNonEmptyString(input?.path) ?? asNonEmptyString(input?.file);
    readPath = rawPath === null ? null : rawPath.slice(0, 256);
    readOffset = toFiniteInt(input?.offset);
    readLimit = toFiniteInt(input?.limit);
  } else {
    const taskMetadata = asRecord(metadata);
    childSessionId = asBoundedId(taskMetadata?.sessionId) ?? asBoundedId(taskMetadata?.sessionID);
  }
  return {
    identity: `${sessionId}/${messageId}/${callId}`,
    sessionId,
    messageId,
    callId,
    tool,
    status,
    timestamp,
    skillName,
    skillDir,
    readPath,
    readOffset,
    readLimit,
    childSessionId,
  };
}

// Splits streamed stdout chunks into complete lines, keeping a trailing
// partial line buffered. Malformed/truncated trailing content stays buffered
// and is reported as incomplete coverage rather than parsed.
export function splitStreamLines(buffer: { text: string }, chunk: string): string[] {
  buffer.text += chunk;
  const lines: string[] = [];
  let index = buffer.text.indexOf('\n');
  while (index >= 0) {
    lines.push(buffer.text.slice(0, index));
    buffer.text = buffer.text.slice(index + 1);
    index = buffer.text.indexOf('\n');
  }
  return lines;
}

export function collectPrimaryToolCalls(lines: readonly string[]): {
  calls: NormalizedToolCall[];
  truncated: boolean;
  malformed: number;
} {
  const calls: NormalizedToolCall[] = [];
  let malformed = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown = null;
    let isJson = true;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      isJson = false;
    }
    if (!isJson) {
      continue;
    }
    const record = asRecord(parsed);
    if (record?.type !== 'tool_use') {
      continue;
    }
    const call = parsePrimaryToolRecord(line);
    if (call === null) {
      malformed += 1;
      continue;
    }
    if (calls.length >= MAX_PRIMARY_TOOL_EVENTS) {
      return { calls, truncated: true, malformed };
    }
    calls.push(call);
  }
  return { calls, truncated: false, malformed };
}

// Child IDs come only from harness-owned task tool metadata on real tool
// records. Session IDs mentioned in prose, model text or tool output are
// never treated as attributable children. Unrelated sessions are never
// listed or imported.
export function discoverChildSessionIds(
  calls: readonly NormalizedToolCall[],
  primarySessionId: string | null,
): { childIds: string[]; truncated: boolean } {
  const seen: string[] = [];
  for (const call of calls) {
    if (call.tool !== 'task') {
      continue;
    }
    if (call.status !== 'completed' && call.status !== 'error') {
      continue;
    }
    const child = call.childSessionId;
    if (child === null || child === primarySessionId) {
      continue;
    }
    if (!seen.includes(child)) {
      seen.push(child);
    }
    if (seen.length >= MAX_CHILD_SESSIONS) {
      return { childIds: seen, truncated: true };
    }
  }
  return { childIds: seen, truncated: false };
}

export interface SessionExportInput {
  info?: unknown;
  messages?: unknown;
}

// Reads tool records from a read-only export of one explicit session ID and
// verifies `export.info.parentID` against the known primary parent. A wrong
// parent, missing export, malformed shape or unrelated session yields no
// records plus an explicit coverage reason — never silent inclusion.
export function collectExportToolRecords(
  sessionId: string,
  exported: SessionExportInput | null | undefined,
  expectedParentId: string | null,
): { calls: NormalizedToolCall[]; reason: string | null } {
  if (exported === null || exported === undefined) {
    return { calls: [], reason: `missing export for session ${sessionId}` };
  }
  const info = asRecord(exported.info);
  if (info === null) {
    return { calls: [], reason: `malformed export for session ${sessionId}` };
  }
  const exportedId = asBoundedId(info.id);
  if (exportedId !== null && exportedId !== sessionId) {
    return { calls: [], reason: `export identity mismatch for session ${sessionId}` };
  }
  const parentId = asBoundedId(info.parentID ?? info.parentId);
  if (expectedParentId !== null) {
    if (parentId === null) {
      return { calls: [], reason: `missing parentID for session ${sessionId}` };
    }
    if (parentId !== expectedParentId) {
      return { calls: [], reason: `wrong parent for session ${sessionId}` };
    }
  }
  if (!Array.isArray(exported.messages)) {
    return { calls: [], reason: `malformed messages for session ${sessionId}` };
  }
  const calls: NormalizedToolCall[] = [];
  for (const message of exported.messages) {
    const messageRecord = asRecord(message);
    if (messageRecord === null) {
      continue;
    }
    const messageInfo = asRecord(messageRecord.info);
    const messageId = asBoundedId(messageInfo?.id);
    if (messageId === null) {
      continue;
    }
    const parts = messageRecord.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const entry of parts) {
      const part = asRecord(entry);
      if (part?.type !== 'tool') {
        continue;
      }
      const tool = asNonEmptyString(part.tool);
      if (tool !== 'skill' && tool !== 'read' && tool !== 'task') {
        continue;
      }
      const callId = asBoundedId(part.id);
      if (callId === null) {
        continue;
      }
      const state = asRecord(part.state);
      const status = state === null ? null : asNonEmptyString(state.status);
      if (status !== 'completed' && status !== 'error') {
        continue;
      }
      const input = state === null ? null : asRecord(state.input);
      const metadata = state === null ? null : asRecord(state.metadata);
      let skillName: string | null = null;
      let skillDir: string | null = null;
      let readPath: string | null = null;
      let readOffset: number | null = null;
      let readLimit: number | null = null;
      let childSessionId: string | null = null;
      if (tool === 'skill') {
        skillName = normalizeSkillName(input?.name);
        skillDir = metadata === null ? null : asBoundedId(metadata.dir);
      } else if (tool === 'read') {
        const rawPath =
          (input === null ? null : asNonEmptyString(input.path)) ??
          (input === null ? null : asNonEmptyString(input.file));
        readPath = rawPath === null ? null : rawPath.slice(0, 256);
        readOffset = input === null ? null : toFiniteInt(input.offset);
        readLimit = input === null ? null : toFiniteInt(input.limit);
      } else {
        childSessionId =
          (metadata === null ? null : asBoundedId(metadata.sessionId)) ??
          (metadata === null ? null : asBoundedId(metadata.sessionID));
      }
      calls.push({
        identity: `${sessionId}/${messageId}/${callId}`,
        sessionId,
        messageId,
        callId,
        tool,
        status,
        timestamp: null,
        skillName,
        skillDir,
        readPath,
        readOffset,
        readLimit,
        childSessionId,
      });
      if (calls.length >= MAX_PRIMARY_TOOL_EVENTS) {
        return { calls, reason: `export truncated for session ${sessionId}` };
      }
    }
  }
  return { calls, reason: null };
}

function provenanceFor(call: NormalizedToolCall): SkillEvidenceEvent['sourceProvenance'] {
  if (call.tool === 'skill' && call.skillName !== null) {
    if (call.skillDir?.includes(`.agents/skills/${call.skillName}`) === true) {
      return 'verified-tool-metadata';
    }
    return 'unknown';
  }
  if (call.tool === 'read' && call.readPath !== null) {
    if (skillNameFromRepoPath(call.readPath) !== null) {
      return 'verified-repo-path';
    }
  }
  return 'unknown';
}

// A read or copy of a skill bundle is never a successful semantic skill
// invocation. Only completed `skill` tool calls with a validated name become
// `skill-invocation`; errored skill tools become `skill-attempt`; validated
// SKILL.md reads become `skill-file-read` with explicit ranges.
function toEvidenceEvent(
  call: NormalizedToolCall,
  invocation: SkillEvidenceInvocation,
): SkillEvidenceEvent | null {
  if (call.tool === 'skill') {
    if (call.skillName === null) {
      return null;
    }
    if (call.status === 'completed') {
      return {
        id: `${invocation.command}/${invocation.axis}/${String(invocation.attempt)}/${call.identity}`,
        kind: 'skill-invocation',
        skillName: call.skillName,
        skillPath: call.skillDir,
        sessionId: call.sessionId,
        messageId: call.messageId,
        callId: call.callId,
        status: call.status,
        timestamp: call.timestamp,
        readRange: null,
        readFullness: 'unknown',
        sourceProvenance: provenanceFor(call),
        collectionNote: null,
      };
    }
    if (call.status === 'error') {
      return {
        id: `${invocation.command}/${invocation.axis}/${String(invocation.attempt)}/${call.identity}`,
        kind: 'skill-attempt',
        skillName: call.skillName,
        skillPath: call.skillDir,
        sessionId: call.sessionId,
        messageId: call.messageId,
        callId: call.callId,
        status: call.status,
        timestamp: call.timestamp,
        readRange: null,
        readFullness: 'unknown',
        sourceProvenance: provenanceFor(call),
        collectionNote: null,
      };
    }
    return null;
  }
  if (call.tool === 'read') {
    if (call.readPath === null) {
      return null;
    }
    const skillName = skillNameFromRepoPath(call.readPath);
    if (skillName === null) {
      return null;
    }
    if (call.status !== 'completed' && call.status !== 'error') {
      return null;
    }
    const range = readRangeOf(call.readOffset, call.readLimit);
    return {
      id: `${invocation.command}/${invocation.axis}/${String(invocation.attempt)}/${call.identity}`,
      kind: 'skill-file-read',
      skillName,
      skillPath: call.readPath,
      sessionId: call.sessionId,
      messageId: call.messageId,
      callId: call.callId,
      status: call.status,
      timestamp: call.timestamp,
      readRange: range,
      readFullness: range === null ? 'unknown' : 'partial',
      sourceProvenance: 'verified-repo-path',
      collectionNote: null,
    };
  }
  return null;
}

export interface BuildEvidenceInput {
  invocation: SkillEvidenceInvocation;
  primaryLines: readonly string[];
  primarySessionId: string | null;
  childExports: Readonly<Record<string, SessionExportInput | null>>;
  exportFailures?: readonly string[];
  truncatedStream?: boolean;
  collectedAt?: string;
}

// Deduplicates repeated streamed updates and export copies of the same
// attributed tool identity while preserving different actual tool calls,
// separate retries and concurrent axes (each axis keeps its own invocation).
export function buildSkillEvidence(input: BuildEvidenceInput): SkillEvidenceRecord {
  const collected = collectPrimaryToolCalls(input.primaryLines);
  const discovered = discoverChildSessionIds(collected.calls, input.primarySessionId);
  const seen = new Set<string>();
  const events: SkillEvidenceEvent[] = [];
  const reasons: string[] = [];
  if (collected.truncated || input.truncatedStream === true) {
    reasons.push('primary stream truncated at bound');
  }
  if (collected.malformed > 0) {
    reasons.push(`ignored ${String(collected.malformed)} malformed tool records`);
  }
  if (discovered.truncated) {
    reasons.push('child traversal truncated at bound');
  }
  for (const failure of input.exportFailures ?? []) {
    reasons.push(failure);
  }
  const pushCall = (call: NormalizedToolCall): void => {
    if (seen.has(call.identity)) {
      return;
    }
    seen.add(call.identity);
    const event = toEvidenceEvent(call, input.invocation);
    if (event === null) {
      return;
    }
    if (events.length >= MAX_EVIDENCE_EVENTS) {
      reasons.push('evidence truncated at bound');
      return;
    }
    events.push(event);
  };
  for (const call of collected.calls) {
    pushCall(call);
  }
  const childIds: string[] = [...discovered.childIds];
  for (const childId of discovered.childIds) {
    const exported = input.childExports[childId];
    const { calls, reason } = collectExportToolRecords(childId, exported, input.primarySessionId);
    if (reason !== null) {
      reasons.push(reason);
      continue;
    }
    for (const call of calls) {
      pushCall(call);
    }
    const nested = discoverChildSessionIds(calls, childId);
    for (const grandchild of nested.childIds) {
      if (!childIds.includes(grandchild)) {
        childIds.push(grandchild);
        reasons.push(`unvisited nested session ${grandchild}`);
      }
    }
  }
  const coverage: SkillEvidenceCoverage =
    input.primarySessionId === null
      ? {
          status: 'unavailable',
          primarySessionId: null,
          childSessionIds: childIds,
          reasons: ['primary session unknown', ...reasons],
        }
      : reasons.length > 0
        ? {
            status: 'incomplete',
            primarySessionId: input.primarySessionId,
            childSessionIds: childIds,
            reasons,
          }
        : {
            status: 'complete',
            primarySessionId: input.primarySessionId,
            childSessionIds: childIds,
            reasons: [],
          };
  const parentIds =
    input.primarySessionId === null ? [] : [input.primarySessionId, ...childIds.slice(0, 0)];
  return {
    version: SKILL_EVIDENCE_VERSION,
    invocation: { ...input.invocation },
    sessionLineage: { primarySessionId: input.primarySessionId, parentIds },
    events,
    coverage,
    collectedAt: input.collectedAt ?? new Date().toISOString(),
  };
}

export function readGitHubAttribution(env: NodeJS.ProcessEnv): {
  runId: string;
  runAttempt: string;
  jobName: string;
} {
  const runId = asNonEmptyString(env.GITHUB_RUN_ID) ?? 'unknown';
  const runAttempt = asNonEmptyString(env.GITHUB_RUN_ATTEMPT) ?? 'unknown';
  const jobName = asNonEmptyString(env.GITHUB_JOB) ?? 'unknown';
  return { runId, runAttempt, jobName };
}

// Sentinel sweep: evidence artifacts and export-related console output must
// never contain secrets, transcripts, reasoning, tool outputs, arbitrary
// arguments or environment values. Only whitelisted metadata is persisted.
const SENTINEL_PATTERN = /(sk-ant-|ghp_|github_pat_|OPENCODE_ZEN_API_KEY|BEGIN PRIVATE KEY)/;

export function evidenceContainsSentinel(record: SkillEvidenceRecord): boolean {
  return SENTINEL_PATTERN.test(JSON.stringify(record));
}

export function serializeSkillEvidence(record: SkillEvidenceRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function evidenceFileName(invocation: SkillEvidenceInvocation): string {
  const safe = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 40) || 'worker';
  return `${safe(invocation.command)}-${safe(invocation.axis)}-${String(invocation.attempt)}.json`;
}
