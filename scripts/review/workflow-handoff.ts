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

export function buildWorkflowPatchArgs(
  base: string,
  head: string,
  files: readonly string[],
): readonly string[] {
  return ['diff', `${base}...${head}`, '--', ...files];
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
    'the reviewed workflow files from the handoff patch, then rerun review against ' +
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
  files: readonly string[],
): Promise<string> {
  const { stdout } = await execute('git', buildWorkflowPatchArgs(base, head, files));
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
