import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandExecutor } from './runner.js';

// Least-privilege workflow-file publication handoff (ticket #36). Remote
// agent corrections may legitimately touch `.github/workflows/**`, but the
// ordinary Actions `GITHUB_TOKEN` cannot publish workflow-file changes and
// model/OpenCode processes must never receive a broad workflow-write
// credential. Repository-owned orchestration detects the change before an
// ordinary push, refuses the doomed generic push with a distinguishable
// `trusted-publication-required` reason, and leaves a durable patch/metadata
// bundle so a trusted publisher can publish the reviewed change without
// reconstructing work from runner logs.
export const WORKFLOW_DIR_PREFIX = '.github/workflows/';
export const WORKFLOW_DIR_ARG = '.github/workflows/';
export const HANDOFF_PATCH_PATH = '.agent-ticket/workflow-handoff.patch';
export const HANDOFF_RECORD_PATH = '.agent-ticket/workflow-handoff.json';
export const TRUSTED_PUBLICATION_MARKER = 'trusted-publication-required';

// Ticket #82 deterministic trusted-handoff provenance. A workflow-file
// correction stops with `trusted-publication-required` and leaves a
// machine-readable marker on the source ticket, created by
// `github-actions[bot]` from the `agent-ticket` run. The marker records at
// least ticket, branch, base SHA, implementation HEAD and the workflow-file
// list. It is deterministic and non-secret; the human-readable BLOCKED
// message remains alongside it. Trust is never inferred from PR author login,
// owner association, title/body, branch naming, or a user-copyable label.
export const TRUSTED_HANDOFF_MARKER_PREFIX = '<!-- trusted-workflow-handoff:v1 ';
export const TRUSTED_HANDOFF_MARKER_SUFFIX = ' -->';
export const TRUSTED_PUBLISHER_APP_SLUG = 'chatgpt-codex-connector';

export interface TrustedHandoffMarker {
  v: 1;
  ticket: number;
  branch: string;
  // Audit evidence identifying which correction the marker belongs to (base
  // SHA and implementation HEAD at handoff time). Per the ticket #82
  // decision, these are not equality gates: trust attaches to the original
  // publication provenance plus the marker, while the approver still checks
  // exact current-HEAD equality independently, so later exact-HEAD
  // corrections pushed through agent-fix-cycle/safe-push remain eligible.
  base: string;
  head: string;
  files: string[];
}

const EXACT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

function isExactSha(value: unknown): value is string {
  return typeof value === 'string' && EXACT_SHA_PATTERN.test(value.trim());
}

export function formatTrustedHandoffMarker(record: {
  ticket: number;
  branch: string;
  base: string;
  head: string;
  files: readonly string[];
}): string {
  const marker: TrustedHandoffMarker = {
    v: 1,
    ticket: record.ticket,
    branch: record.branch,
    base: record.base,
    head: record.head,
    files: [...record.files].sort(),
  };
  return `${TRUSTED_HANDOFF_MARKER_PREFIX}${JSON.stringify(marker)}${TRUSTED_HANDOFF_MARKER_SUFFIX}`;
}

export function parseTrustedHandoffMarker(
  body: string | undefined | null,
): TrustedHandoffMarker | null {
  if (typeof body !== 'string') {
    return null;
  }
  const start = body.indexOf(TRUSTED_HANDOFF_MARKER_PREFIX);
  if (start === -1) {
    return null;
  }
  const jsonStart = start + TRUSTED_HANDOFF_MARKER_PREFIX.length;
  const end = body.indexOf(TRUSTED_HANDOFF_MARKER_SUFFIX, jsonStart);
  if (end === -1) {
    return null;
  }
  const raw = body.slice(jsonStart, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (candidate.v !== 1) {
    return null;
  }
  if (
    typeof candidate.ticket !== 'number' ||
    !Number.isInteger(candidate.ticket) ||
    candidate.ticket <= 0
  ) {
    return null;
  }
  if (typeof candidate.branch !== 'string' || candidate.branch.trim() === '') {
    return null;
  }
  if (!isExactSha(candidate.base) || !isExactSha(candidate.head)) {
    return null;
  }
  if (!Array.isArray(candidate.files)) {
    return null;
  }
  const files: string[] = [];
  for (const entry of candidate.files) {
    if (typeof entry !== 'string') {
      return null;
    }
    const normalized = normalizeHandoffPath(entry);
    if (!isWorkflowFile(normalized)) {
      return null;
    }
    files.push(normalized);
  }
  return {
    v: 1,
    ticket: candidate.ticket,
    branch: candidate.branch,
    base: candidate.base.trim(),
    head: candidate.head.trim(),
    files: [...new Set(files)].sort(),
  };
}

// A PR's workflow-file set is covered only when every workflow file in the
// PR appears in the marker. An empty PR workflow-file set is never covered
// through the handoff exception: only a workflow-file correction may use
// trusted-handoff provenance. Matching is deliberately limited to ticket,
// branch, and file coverage; the marker base/head stay audit evidence (see
// TrustedHandoffMarker) while exact current-HEAD equality is enforced
// separately by the approver.
export function isHandoffCovering(
  marker: TrustedHandoffMarker,
  workflowFiles: readonly string[],
): boolean {
  if (workflowFiles.length === 0) {
    return false;
  }
  const covered = new Set(marker.files);
  return workflowFiles.every((file) => covered.has(normalizeHandoffPath(file)));
}

export function findMatchingHandoffMarker(
  markers: readonly TrustedHandoffMarker[],
  options: { ticket: number; branch: string; workflowFiles: readonly string[] },
): TrustedHandoffMarker | null {
  for (const marker of markers) {
    if (marker.ticket !== options.ticket) {
      continue;
    }
    if (marker.branch !== options.branch) {
      continue;
    }
    if (!isHandoffCovering(marker, options.workflowFiles)) {
      continue;
    }
    return marker;
  }
  return null;
}

export function normalizeHandoffPath(path: string): string {
  let normalized = path.trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

export function isWorkflowFile(path: string): boolean {
  const normalized = normalizeHandoffPath(path);
  if (normalized === '' || !normalized.startsWith(WORKFLOW_DIR_PREFIX)) {
    return false;
  }
  const rest = normalized.slice(WORKFLOW_DIR_PREFIX.length);
  if (rest === '' || rest.endsWith('/')) {
    return false;
  }
  return true;
}

export function listWorkflowFiles(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeHandoffPath(path);
    if (isWorkflowFile(normalized)) {
      seen.add(normalized);
    }
  }
  return [...seen].sort();
}

export function parseNameOnlyOutput(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      paths.push(trimmed);
    }
  }
  return paths;
}

// Deterministic range diff scoped to the workflows directory so detection
// cannot drift between orchestrators. Callers pass exact SHAs they already
// hold (branch base and HEAD), never a moving ref.
export function buildWorkflowDiffArgs(base: string, head: string): readonly string[] {
  return ['diff', '--name-only', `${base}...${head}`, '--', WORKFLOW_DIR_ARG];
}

// Deterministic full-range patch so the handoff bundle preserves the
// complete correction (a correction may also contain scripts/tests/docs
// alongside workflow files). The record's `files` list still identifies the
// workflow files that triggered trusted handoff. Callers pass exact SHAs
// they already hold (branch base and HEAD), never a moving ref.
export function buildWorkflowPatchArgs(base: string, head: string): readonly string[] {
  return ['diff', `${base}...${head}`, '--'];
}

// Deliberately distinct from ordinary safe-push refusal text: the terminal
// workflow step distinguishes this handoff from branch/base/dirty failures.
export function formatHandoffReason(files: readonly string[]): string {
  const names = files.join(', ');
  return (
    `${TRUSTED_PUBLICATION_MARKER}: the correction touches workflow files (${names}). ` +
    'Ordinary automation stops before the generic push because its credential cannot publish ' +
    'workflow files. A trusted human or separately authorized ChatGPT GitHub operation ' +
    'publishes the reviewed change, then exact-HEAD review resumes on the published HEAD.'
  );
}

export function formatHandoffAction(): string {
  return (
    'Ask a trusted human or separately authorized ChatGPT GitHub operation to publish ' +
    'the reviewed correction from the handoff patch, then rerun review against ' +
    'the newly published exact HEAD. Keep ordinary automation least-privilege: ' +
    'do not widen model credentials.'
  );
}

export interface WorkflowHandoffRecord {
  version: 1;
  branch: string;
  base: string;
  head: string;
  files: string[];
  patchPath: string;
  reason: string;
  createdAt: string;
}

export interface BuildHandoffRecordInput {
  branch: string;
  base: string;
  head: string;
  files: readonly string[];
  createdAt?: string;
}

export function buildHandoffRecord(input: BuildHandoffRecordInput): WorkflowHandoffRecord {
  return {
    version: 1,
    branch: input.branch,
    base: input.base,
    head: input.head,
    files: [...input.files],
    patchPath: HANDOFF_PATCH_PATH,
    reason: formatHandoffReason(input.files),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function serializeHandoffRecord(record: WorkflowHandoffRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function listChangedWorkflowFiles(
  execute: CommandExecutor,
  base: string,
  head: string,
): Promise<string[]> {
  const { stdout } = await execute('git', buildWorkflowDiffArgs(base, head));
  return listWorkflowFiles(parseNameOnlyOutput(stdout));
}

export async function getWorkflowPatch(
  execute: CommandExecutor,
  base: string,
  head: string,
): Promise<string> {
  const { stdout } = await execute('git', buildWorkflowPatchArgs(base, head));
  return stdout;
}

// Durable evidence bundle (ticket #36): the patch plus exact base/head
// metadata are persisted under `.agent-ticket/` so a trusted publisher can
// publish the reviewed workflow change without reconstructing work from
// runner logs. Remote workflows upload these paths as run artifacts.
export async function persistWorkflowHandoffBundle(
  record: WorkflowHandoffRecord,
  patch: string,
): Promise<void> {
  await fs.mkdir(dirname(HANDOFF_RECORD_PATH), { recursive: true });
  await fs.writeFile(HANDOFF_PATCH_PATH, patch, 'utf8');
  await fs.writeFile(HANDOFF_RECORD_PATH, serializeHandoffRecord(record), 'utf8');
}
