import { describe, expect, it } from 'vitest';
import {
  ADDRESS_REVIEW_TIMEOUT_MS,
  IMPLEMENT_TIMEOUT_MS,
  REVIEW_CYCLE_TIMEOUT_MS,
  REVIEWER_TIMEOUT_MS,
  WorkerTimeoutError,
  isWorkerTimeout,
  timeoutForWorker,
} from '../../scripts/review/worker-timeout.js';

// Seam under test: bounded worker/process timeouts (ticket #31).
// A reviewer or implementer that stops producing useful progress must not run
// indefinitely; a timeout is distinct from model/gate/CI/human/stale-head
// failures and must terminate the hung subprocess tree cleanly.
describe('worker timeout policy', () => {
  it('bounds every OpenCode worker with a positive finite timeout', () => {
    for (const timeout of [
      REVIEWER_TIMEOUT_MS,
      IMPLEMENT_TIMEOUT_MS,
      ADDRESS_REVIEW_TIMEOUT_MS,
      REVIEW_CYCLE_TIMEOUT_MS,
    ]) {
      expect(Number.isFinite(timeout)).toBe(true);
      expect(timeout).toBeGreaterThan(0);
    }
  });

  it('keeps reviewer timeouts well below the observed 7700s hang', () => {
    const observedHangMs = 7_700_000;

    expect(REVIEWER_TIMEOUT_MS).toBeLessThan(observedHangMs);
    expect(ADDRESS_REVIEW_TIMEOUT_MS).toBeLessThan(observedHangMs);
    expect(IMPLEMENT_TIMEOUT_MS).toBeLessThan(observedHangMs);
  });

  it('resolves a bounded timeout for each known worker label', () => {
    expect(timeoutForWorker('standards')).toBe(REVIEWER_TIMEOUT_MS);
    expect(timeoutForWorker('spec')).toBe(REVIEWER_TIMEOUT_MS);
    expect(timeoutForWorker('implement')).toBe(IMPLEMENT_TIMEOUT_MS);
    expect(timeoutForWorker('address-review')).toBe(ADDRESS_REVIEW_TIMEOUT_MS);
    expect(timeoutForWorker('review-cycle')).toBe(REVIEW_CYCLE_TIMEOUT_MS);
  });

  it('distinguishes worker timeouts from model, gate, CI, and cancellation failures', () => {
    const timeout = new WorkerTimeoutError('standards', 1234, 'opencode run --auto');

    expect(isWorkerTimeout(timeout)).toBe(true);
    expect(isWorkerTimeout(new Error('opencode run failed (exit 1)'))).toBe(false);
    expect(isWorkerTimeout(new Error('CI checks failed'))).toBe(false);
    expect(isWorkerTimeout(null)).toBe(false);
    expect(timeout.code).toBe('WORKER_TIMEOUT');
    expect(timeout.message).toMatch(/standards/);
    expect(timeout.message).toMatch(/timeout/i);
  });
});
