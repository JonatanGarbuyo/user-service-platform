import * as fs from 'node:fs/promises';
import { expectedModelForAxis, type ReviewAxis, type ReviewResult } from './result-marker.js';

// Structured review-cycle run summaries (ticket #22). Every invocation
// persists concise machine-readable evidence — per-axis attempt timings,
// retries as distinct attempts, gate/CI results, terminal outcome — so
// operational facts never have to be reconstructed from terminal scrollback.
// The summary is intentionally narrow: identifiers, timestamps, durations,
// counts and pass/fail outcomes only. Raw model transcripts, verification or
// reset URLs, tokens and environment values are never persisted.
export const RUN_SUMMARY_DIR = '.review-cycle';
export const RUN_SUMMARY_LATEST = 'latest.json';

export type TerminalOutcome = 'READY' | 'NEEDS-DECISION' | 'BLOCKED' | 'STOPPED' | 'FATAL';

export type WorkerAttemptResult = ReviewResult | 'MISSING' | 'ERROR';

export interface WorkerAttempt {
  axis: ReviewAxis;
  attempt: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  model: string;
  result: WorkerAttemptResult;
}

export type AddressReviewOutcome = 'advanced' | 'unchanged' | 'error';

export interface AddressReviewAttempt {
  attempt: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outcome: AddressReviewOutcome;
}

export interface GateSummary {
  name: string;
  ok: boolean;
}

export interface CheckRunSummary {
  name: string;
  status: string;
  conclusion: string | null;
}

export type CiDecision = 'pass' | 'fail' | 'pending' | 'unknown';

export interface PrSummary {
  number: number;
  url?: string;
  headRefName?: string;
  baseRefName?: string;
}

export interface RunSummary {
  version: 1;
  command: 'review:cycle';
  startedAt: string;
  endedAt: string;
  durationMs: number;
  pr?: PrSummary;
  branch?: string;
  base?: string;
  reviewedHead: string;
  initialHead?: string;
  correctionCycles: number;
  markerRetries: Record<ReviewAxis, number>;
  standardsAttempts: WorkerAttempt[];
  specAttempts: WorkerAttempt[];
  addressReviewAttempts: AddressReviewAttempt[];
  qualityGates: GateSummary[];
  ci: { decision: CiDecision; runs: CheckRunSummary[] };
  outcome: TerminalOutcome;
  detail?: string;
}

export interface RecorderOptions {
  now?: () => number;
}

function toIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function toDuration(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, endedAtMs - startedAtMs);
}

export function modelForAxis(axis: ReviewAxis): string {
  return expectedModelForAxis(axis);
}

export function summaryFileName(startedAtIso: string): string {
  const safe = startedAtIso.replace(/:/g, '-').replace(/\./g, '-');
  return `review-cycle-${safe}.json`;
}

export function formatSummaryPathMessage(latestPath: string): string {
  return `Run summary: ${latestPath}`;
}

export interface RunSummaryRecorder {
  recordWorkerAttempt(
    axis: ReviewAxis,
    result: WorkerAttemptResult,
    startedAtMs: number,
    endedAtMs: number,
  ): void;
  recordAddressReviewAttempt(
    outcome: AddressReviewOutcome,
    startedAtMs: number,
    endedAtMs: number,
  ): void;
  setPr(pr: PrSummary): void;
  setBranch(branch: string, base: string): void;
  setReviewedHead(head: string): void;
  setInitialHead(head: string): void;
  setMarkerRetries(retries: Record<ReviewAxis, number>): void;
  setQualityGates(gates: GateSummary[]): void;
  setCi(decision: CiDecision, runs?: CheckRunSummary[]): void;
  finish(outcome: TerminalOutcome, detail?: string): RunSummary;
}

export function createRunSummaryRecorder(options: RecorderOptions = {}): RunSummaryRecorder {
  const now = options.now ?? Date.now;
  const runStartedAtMs = now();
  const standardsAttempts: WorkerAttempt[] = [];
  const specAttempts: WorkerAttempt[] = [];
  const addressReviewAttempts: AddressReviewAttempt[] = [];
  let pr: PrSummary | undefined;
  let branch: string | undefined;
  let base: string | undefined;
  let reviewedHead = '';
  let initialHead: string | undefined;
  let markerRetries: Record<ReviewAxis, number> = { standards: 0, spec: 0 };
  let qualityGates: GateSummary[] = [];
  let ci: { decision: CiDecision; runs: CheckRunSummary[] } = { decision: 'unknown', runs: [] };

  function build(outcome: TerminalOutcome, detail: string | undefined): RunSummary {
    const endedAtMs = now();
    const summary: RunSummary = {
      version: 1,
      command: 'review:cycle',
      startedAt: toIso(runStartedAtMs),
      endedAt: toIso(endedAtMs),
      durationMs: toDuration(runStartedAtMs, endedAtMs),
      reviewedHead,
      correctionCycles: addressReviewAttempts.length,
      markerRetries: { ...markerRetries },
      standardsAttempts: [...standardsAttempts],
      specAttempts: [...specAttempts],
      addressReviewAttempts: [...addressReviewAttempts],
      qualityGates: [...qualityGates],
      ci: { decision: ci.decision, runs: [...ci.runs] },
      outcome,
    };
    if (pr !== undefined) {
      summary.pr = { ...pr };
    }
    if (branch !== undefined) {
      summary.branch = branch;
    }
    if (base !== undefined) {
      summary.base = base;
    }
    if (initialHead !== undefined) {
      summary.initialHead = initialHead;
    }
    if (detail !== undefined && detail !== '') {
      summary.detail = detail;
    }
    return summary;
  }

  return {
    recordWorkerAttempt(axis, result, startedAtMs, endedAtMs) {
      const attempts = axis === 'standards' ? standardsAttempts : specAttempts;
      attempts.push({
        axis,
        attempt: attempts.length + 1,
        startedAt: toIso(startedAtMs),
        endedAt: toIso(endedAtMs),
        durationMs: toDuration(startedAtMs, endedAtMs),
        model: modelForAxis(axis),
        result,
      });
    },
    recordAddressReviewAttempt(outcome, startedAtMs, endedAtMs) {
      addressReviewAttempts.push({
        attempt: addressReviewAttempts.length + 1,
        startedAt: toIso(startedAtMs),
        endedAt: toIso(endedAtMs),
        durationMs: toDuration(startedAtMs, endedAtMs),
        outcome,
      });
    },
    setPr(next: PrSummary) {
      pr = { ...next };
    },
    setBranch(nextBranch: string, nextBase: string) {
      branch = nextBranch;
      base = nextBase;
    },
    setReviewedHead(head: string) {
      reviewedHead = head;
    },
    setInitialHead(head: string) {
      initialHead = head;
    },
    setMarkerRetries(retries: Record<ReviewAxis, number>) {
      markerRetries = { ...retries };
    },
    setQualityGates(gates: GateSummary[]) {
      qualityGates = gates.map((gate) => ({ name: gate.name, ok: gate.ok }));
    },
    setCi(decision: CiDecision, runs: CheckRunSummary[] = []) {
      ci = {
        decision,
        runs: runs.map((run) => ({
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
        })),
      };
    },
    finish(outcome: TerminalOutcome, detail?: string) {
      return build(outcome, detail);
    },
  };
}

export interface PersistDeps {
  mkdir?: (dir: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (path: string, contents: string) => Promise<unknown>;
  dir?: string;
}

export interface PersistResult {
  timestampedPath: string;
  latestPath: string;
}

// Safe persistence: always writes under the repository-local ignored
// directory, creating it first. Callers treat failures as best-effort so a
// summary can never turn a terminal state into a second fatal error.
export async function persistRunSummary(
  summary: RunSummary,
  deps: PersistDeps = {},
): Promise<PersistResult> {
  const dir = deps.dir ?? RUN_SUMMARY_DIR;
  const mkdir =
    deps.mkdir ?? ((path: string, options: { recursive: boolean }) => fs.mkdir(path, options));
  const writeFile =
    deps.writeFile ?? ((path: string, contents: string) => fs.writeFile(path, contents, 'utf8'));
  const timestampedPath = `${dir}/${summaryFileName(summary.startedAt)}`;
  const latestPath = `${dir}/${RUN_SUMMARY_LATEST}`;
  const contents = `${JSON.stringify(summary, null, 2)}\n`;
  await mkdir(dir, { recursive: true });
  await writeFile(timestampedPath, contents);
  await writeFile(latestPath, contents);
  return { timestampedPath, latestPath };
}
