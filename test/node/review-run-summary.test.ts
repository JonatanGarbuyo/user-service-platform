import { describe, expect, it, vi } from 'vitest';
import {
  RUN_SUMMARY_DIR,
  createRunSummaryRecorder,
  formatSummaryPathMessage,
  persistRunSummary,
  summaryFileName,
  type RunSummary,
} from '../../scripts/review/run-summary.js';

// Seam under test: structured review-cycle run summaries (ticket #22).
// Every invocation must persist concise machine-readable evidence —
// per-axis attempt timings, retries as distinct attempts, terminal outcomes —
// without raw model transcripts or sensitive values, under .review-cycle/.
describe('review run summary file names', () => {
  it('builds a timestamped file name safe for the filesystem', () => {
    const name = summaryFileName('2026-09-11T12:00:00.000Z');

    expect(name).toBe('review-cycle-2026-09-11T12-00-00-000Z.json');
    expect(name).not.toContain(':');
  });

  it('formats the terminal summary-path message', () => {
    expect(formatSummaryPathMessage('.review-cycle/latest.json')).toBe(
      'Run summary: .review-cycle/latest.json',
    );
  });
});

describe('review run summary timing accumulation', () => {
  it('accumulates per-axis attempt durations queryable without terminal output', () => {
    let now = 1_000;
    const recorder = createRunSummaryRecorder({ now: () => now });

    now = 2_000;
    recorder.recordWorkerAttempt('standards', 'PASS', 1_000, 2_500);
    recorder.recordWorkerAttempt('spec', 'FAIL', 1_200, 3_200);
    const summary = recorder.finish('BLOCKED');

    expect(summary.standardsAttempts).toHaveLength(1);
    expect(summary.standardsAttempts[0]).toMatchObject({
      axis: 'standards',
      attempt: 1,
      durationMs: 1500,
      model: 'mimo-v2.5',
      result: 'PASS',
    });
    expect(summary.specAttempts[0]).toMatchObject({
      axis: 'spec',
      attempt: 1,
      durationMs: 2000,
      model: 'north-mini-code-free',
      result: 'FAIL',
    });
    expect(summary.outcome).toBe('BLOCKED');
  });

  it('represents missing-marker retries as distinct attempts', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.recordWorkerAttempt('spec', 'MISSING', 0, 500);
    recorder.recordWorkerAttempt('spec', 'PASS', 600, 900);
    const summary = recorder.finish('READY');

    expect(summary.specAttempts).toHaveLength(2);
    expect(summary.specAttempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(summary.specAttempts.map((attempt) => attempt.result)).toEqual(['MISSING', 'PASS']);
  });

  it('records address-review attempts with outcomes', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.recordAddressReviewAttempt('advanced', 0, 1_000);
    recorder.recordAddressReviewAttempt('unchanged', 2_000, 2_500);
    const summary = recorder.finish('STOPPED');

    expect(summary.addressReviewAttempts).toHaveLength(2);
    expect(summary.correctionCycles).toBe(2);
    expect(summary.addressReviewAttempts[0]).toMatchObject({
      attempt: 1,
      durationMs: 1000,
      outcome: 'advanced',
    });
  });

  it('captures terminal outcomes with the final known state', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });

    recorder.setReviewedHead('a'.repeat(40));
    const summary = recorder.finish('FATAL', 'worker blew up');

    expect(summary.outcome).toBe('FATAL');
    expect(summary.detail).toBe('worker blew up');
    expect(summary.reviewedHead).toBe('a'.repeat(40));
  });
});

describe('review run summary safe persistence', () => {
  function baseSummary(): RunSummary {
    const recorder = createRunSummaryRecorder({ now: () => 0 });
    recorder.setPr({ number: 21, headRefName: 'chore/22-x', baseRefName: 'main' });
    recorder.setReviewedHead('b'.repeat(40));
    return recorder.finish('READY');
  }

  it('writes a timestamped summary and updates latest.json', async () => {
    const written = new Map<string, string>();
    const mkdir = vi.fn(() => Promise.resolve());
    const writeFile = vi.fn((path: string, contents: string) => {
      written.set(path, contents);
      return Promise.resolve();
    });

    const result = await persistRunSummary(baseSummary(), { mkdir, writeFile });

    expect(mkdir).toHaveBeenCalledWith(RUN_SUMMARY_DIR, { recursive: true });
    expect(result.timestampedPath.startsWith(`${RUN_SUMMARY_DIR}/review-cycle-`)).toBe(true);
    expect(result.latestPath).toBe(`${RUN_SUMMARY_DIR}/latest.json`);
    expect(written.has(result.timestampedPath)).toBe(true);
    expect(written.has(result.latestPath)).toBe(true);
    const parsed = JSON.parse(String(written.get(result.latestPath))) as RunSummary;
    expect(parsed.outcome).toBe('READY');
  });

  it('persists only concise structured fields, never raw transcripts or secrets', async () => {
    let latestContents = '';
    await persistRunSummary(baseSummary(), {
      mkdir: () => Promise.resolve(),
      writeFile: (path: string, contents: string) => {
        if (path.endsWith('latest.json')) {
          latestContents = contents;
        }
        return Promise.resolve();
      },
    });

    const parsed = JSON.parse(latestContents) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    expect(keys).not.toContain('transcript');
    expect(keys).not.toContain('token');
    expect(keys).not.toContain('env');
    expect(latestContents).not.toContain('ghp_');
    expect(parsed).toMatchObject({
      version: 1,
      command: 'review:cycle',
      outcome: 'READY',
    });
  });
});
