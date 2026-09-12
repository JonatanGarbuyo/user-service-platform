import { describe, expect, it } from 'vitest';
import { createRunSummaryRecorder } from '../../scripts/review/run-summary.js';

// Seam under test: timeout/stage evidence in structured summaries (ticket #31).
// Terminal, fatal, cancelled, and timed-out runs must persist the last known
// stage and timeout reason so timeout/stage information survives in
// `.review-cycle/latest.json` without terminal scrollback.
describe('run summary timeout and stage evidence', () => {
  it('records the last known stage on the summary', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.setReviewedHead('a'.repeat(40));
    recorder.setStage('Standards review');
    const summary = recorder.finish('BLOCKED', 'quality gates failed');

    expect(summary.stage).toBe('Standards review');
    expect(summary.outcome).toBe('BLOCKED');
  });

  it('records a worker timeout with its bound and reports a TIMEOUT outcome', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.setReviewedHead('b'.repeat(40));
    recorder.setStage('Standards review');
    recorder.recordTimeout('standards', 1_200_000);
    const summary = recorder.finish('TIMEOUT', 'standards worker exceeded its bound');

    expect(summary.outcome).toBe('TIMEOUT');
    expect(summary.timeout).toMatchObject({ worker: 'standards', timeoutMs: 1_200_000 });
    expect(summary.stage).toBe('Standards review');
    expect(summary.detail).toBe('standards worker exceeded its bound');
  });

  it('omits timeout evidence when no timeout occurred', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.setReviewedHead('c'.repeat(40));
    const summary = recorder.finish('READY');

    expect(summary.timeout).toBeUndefined();
  });
});
