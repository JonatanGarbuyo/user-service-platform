// Bounded worker/process timeouts (ticket #31). A reviewer or implementer
// that stops producing useful progress must not run indefinitely: the
// observed `still running (... waiting for output)` hang lasted more than
// 7,700 seconds, so every OpenCode worker gets an explicit bound well below
// that. Timeouts are distinct from model failure, gate failure, CI failure,
// human decisions, stale HEAD, and workflow cancellation so the durable
// status surface can report TIMEOUT with its own stage/reason/action.
export const REVIEWER_TIMEOUT_MS = 20 * 60 * 1000;
export const IMPLEMENT_TIMEOUT_MS = 30 * 60 * 1000;
export const ADDRESS_REVIEW_TIMEOUT_MS = 20 * 60 * 1000;
export const REVIEW_CYCLE_TIMEOUT_MS = 60 * 60 * 1000;
// Deterministic quality-gate suite bound (ticket #31): lint, formatting,
// typecheck, OpenAPI drift, and both test suites normally finish in a few
// minutes. A hung gate command must fail bounded like any worker.
export const GATE_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKER_KILL_GRACE_MS = 5_000;

export type WorkerLabel =
  'standards' | 'spec' | 'implement' | 'address-review' | 'review-cycle' | 'gates';

export class WorkerTimeoutError extends Error {
  readonly code = 'WORKER_TIMEOUT';
  readonly workerLabel: string;
  readonly timeoutMs: number;
  readonly invocation: string;

  constructor(workerLabel: string, timeoutMs: number, invocation: string) {
    super(`Worker timeout: ${workerLabel} exceeded ${String(timeoutMs)}ms: ${invocation}`);
    this.name = 'WorkerTimeoutError';
    this.workerLabel = workerLabel;
    this.timeoutMs = timeoutMs;
    this.invocation = invocation;
  }
}

export function isWorkerTimeout(error: unknown): error is WorkerTimeoutError {
  return (
    error instanceof WorkerTimeoutError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'WORKER_TIMEOUT')
  );
}

export interface WorkerTimeoutDetails {
  workerLabel: string;
  timeoutMs: number;
}

// Typed timeout detail extraction so callers never probe error internals with
// ad-hoc casts: a timeout carries which worker exceeded which bound, anything
// else yields `undefined` (model, gate, CI, human-decision, stale-HEAD, and
// cancellation failures are not timeouts).
export function timeoutDetails(error: unknown): WorkerTimeoutDetails | undefined {
  if (error instanceof WorkerTimeoutError) {
    return { workerLabel: error.workerLabel, timeoutMs: error.timeoutMs };
  }
  if (typeof error === 'object' && error !== null) {
    const record = error as { workerLabel?: unknown; timeoutMs?: unknown };
    if (typeof record.workerLabel === 'string' && typeof record.timeoutMs === 'number') {
      return { workerLabel: record.workerLabel, timeoutMs: record.timeoutMs };
    }
  }
  return undefined;
}

// Single mapping from worker label to its bound so local orchestration
// (`review:cycle`, `address-review` invocation from wrappers, `agent:ticket`
// implement/review workers, quality gates) shares the same bounded semantics.
export function timeoutForWorker(label: WorkerLabel): number {
  if (label === 'implement') {
    return IMPLEMENT_TIMEOUT_MS;
  }
  if (label === 'address-review') {
    return ADDRESS_REVIEW_TIMEOUT_MS;
  }
  if (label === 'review-cycle') {
    return REVIEW_CYCLE_TIMEOUT_MS;
  }
  if (label === 'gates') {
    return GATE_TIMEOUT_MS;
  }
  return REVIEWER_TIMEOUT_MS;
}
