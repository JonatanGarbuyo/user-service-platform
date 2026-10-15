// Timeout-resilient reviewer-progress capture (ticket #161).
//
// Standards review of the large PR #154 diff repeatedly exhausts its
// 20-minute bound with `unavailable` lifecycle evidence: skill evidence is
// finalized only after the worker settles, so a silent-then-killed worker
// leaves no observable progress. This module adds the smallest secret-safe
// incremental layer on the existing worker/evidence seams: it reuses the
// shared worker-lifecycle projection (`summarizeWorkerLifecycle`) and the
// repository-ignored run-summary directory convention, persisting bounded
// allowlisted metadata (timestamps, event/tool counts, lineage, status and
// completeness) while the worker is still running.
//
// What never enters durable evidence: prompts, model text, reasoning, tool
// inputs/outputs, shell commands, raw error content, credentials, tokens,
// user data, or observer heartbeat lines. Observer cadence (`sequence`,
// `observedAt`) is labeled observer metadata and never counts as reviewer
// progress: zero captured worker events stays `unavailable`, never complete.
// Capture/persistence failures are best-effort and never change the worker
// outcome, timeout classification, model, bound, retry/permission policy,
// exact-HEAD markers or CI requirements.

import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  emptyWorkerErrorSummary,
  summarizeWorkerLifecycle,
  type WorkerErrorSummary,
} from './implementation-recovery.js';

export const PROGRESS_VERSION = 1 as const;

// Repository-ignored progress directory alongside the run-summary convention
// (`.review-cycle/` is git-ignored): incremental snapshots survive a worker
// timeout even when final skill-evidence finalization has nothing to project.
export const REVIEWER_PROGRESS_DIR = '.review-cycle/progress';

export type ReviewerProgressStatus = 'complete' | 'incomplete' | 'unavailable';

export interface ReviewerProgressIdentity {
  worker: string;
  command: string;
  axis: string;
  attempt: number;
  workerStartHead: string;
  targetHead?: string;
  boundMs?: number;
}

export interface ReviewerProgressSnapshot {
  version: typeof PROGRESS_VERSION;
  identity: ReviewerProgressIdentity;
  // Observer cadence metadata, not reviewer progress: the nth incremental
  // observation at an observer wall-clock instant. Heartbeat liveness must
  // never flip status or fabricate worker counts/timestamps.
  sequence: number;
  observedAt: string;
  capturedLineCount: number;
  eventCounts: Record<string, number>;
  toolCounts: Record<string, number>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  durationMs: number | null;
  lastStatus: string | null;
  malformed: number;
  unknownEvents: number;
  status: ReviewerProgressStatus;
  reasons: string[];
  captureTruncated: boolean;
  errors: WorkerErrorSummary;
}

export interface ProjectProgressOptions {
  observedAt?: string;
  captureTruncated?: boolean;
  now?: () => string;
}

// Pure projection over the captured worker stdout lines observed so far.
// Only allowlisted lifecycle metadata is read into the snapshot; raw line
// content is never copied, reparsed for text, or persisted.
export function projectReviewerProgress(
  lines: readonly string[],
  identity: ReviewerProgressIdentity,
  sequence: number,
  options: ProjectProgressOptions = {},
): ReviewerProgressSnapshot {
  const truncated = options.captureTruncated === true;
  const summary = summarizeWorkerLifecycle(lines);
  const reasons = [...summary.reasons];
  if (truncated) {
    reasons.push('captured stream truncated at configured bound');
  }
  const durationMs =
    summary.firstTimestamp !== null &&
    summary.lastTimestamp !== null &&
    summary.durationMs !== null &&
    Number.isFinite(summary.durationMs) &&
    summary.durationMs >= 0
      ? summary.durationMs
      : null;
  let status: ReviewerProgressStatus;
  if (summary.status === 'unavailable') {
    status = 'unavailable';
  } else {
    status = reasons.length > 0 ? 'incomplete' : 'complete';
  }
  const observedAt = options.observedAt ?? (options.now ?? (() => new Date().toISOString()))();
  return {
    version: PROGRESS_VERSION,
    identity: { ...identity },
    sequence,
    observedAt,
    capturedLineCount: lines.length,
    eventCounts: { ...summary.eventCounts },
    toolCounts: { ...summary.toolCounts },
    firstTimestamp: summary.firstTimestamp,
    lastTimestamp: summary.lastTimestamp,
    durationMs,
    lastStatus: summary.lastStatus,
    malformed: summary.malformed,
    unknownEvents: summary.unknownEvents,
    status,
    reasons: reasons.slice(0, 4),
    captureTruncated: truncated,
    errors: summary.errors ?? emptyWorkerErrorSummary(),
  };
}

export function serializeReviewerProgress(snapshot: ReviewerProgressSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function progressFileName(identity: ReviewerProgressIdentity): string {
  const safe = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 40) || 'worker';
  return `${safe(identity.command)}-${safe(identity.axis)}-${String(identity.attempt)}.json`;
}

// Default observer cadence: frequent enough that a 20-minute reviewer timeout
// retains minute-level progress, sparse enough to stay negligible next to
// worker I/O. This cadence is observer metadata only and never reviewer
// progress.
export const PROGRESS_SNAPSHOT_INTERVAL_MS = 60_000;

export interface ReviewerProgressCapture {
  lines: readonly string[];
  wasTruncated: () => boolean;
}

export interface ReviewerProgressProbeDeps {
  dir?: string;
  intervalMs?: number;
  now?: () => string;
  mkdir?: (dir: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (path: string, contents: string) => Promise<unknown>;
}

export interface ReviewerProgressProbe {
  latestPath: string;
  // Best-effort incremental persist: failures are logged with a fixed
  // metadata-only message and never thrown, so capture can never mask the
  // worker outcome or timeout classification.
  snapshotNow: () => Promise<void>;
  stop: () => void;
}

// Incremental timeout-resilient capture over a live worker stdout capture.
// The probe observes the same mutable capture the worker executor pushes into
// and persists one allowlisted snapshot per observer tick plus a final
// snapshot on stop, so a timeout or termination retains the latest projected
// progress (or an explicit incomplete/unavailable record) instead of nothing.
export function startReviewerProgressProbe(
  identity: ReviewerProgressIdentity,
  capture: ReviewerProgressCapture,
  deps: ReviewerProgressProbeDeps = {},
): ReviewerProgressProbe {
  const dir = deps.dir ?? REVIEWER_PROGRESS_DIR;
  const intervalMs = deps.intervalMs ?? PROGRESS_SNAPSHOT_INTERVAL_MS;
  const now = deps.now ?? (() => new Date().toISOString());
  const mkdir =
    deps.mkdir ?? ((path: string, options: { recursive: boolean }) => fs.mkdir(path, options));
  const writeFile =
    deps.writeFile ?? ((path: string, contents: string) => fs.writeFile(path, contents, 'utf8'));
  const latestPath = `${dir}/${progressFileName(identity)}`;
  let sequence = 0;
  let stopped = false;

  const snapshotNow = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    sequence += 1;
    try {
      const snapshot = projectReviewerProgress(capture.lines, identity, sequence, {
        observedAt: now(),
        captureTruncated: capture.wasTruncated(),
      });
      await mkdir(dirname(latestPath), { recursive: true });
      await writeFile(latestPath, serializeReviewerProgress(snapshot));
    } catch {
      // Best-effort: fixed metadata-only diagnostic, never the failure
      // detail (which could carry paths or provider output).
      console.error(`Reviewer progress snapshot failed for ${identity.axis}`);
    }
  };

  const timer = setInterval(() => {
    void snapshotNow();
  }, intervalMs);
  // The observer must never hold the event loop open for the worker.
  if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }

  return {
    latestPath,
    snapshotNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
