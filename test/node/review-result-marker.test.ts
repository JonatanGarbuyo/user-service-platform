import { describe, expect, it } from 'vitest';
import {
  formatReviewMarker,
  parseReviewMarkers,
  selectCurrentHeadReports,
} from '../../scripts/review/result-marker.js';

// Seam under test: deterministic review-report marker parsing (ticket #16).
// The orchestrator must not infer pass/fail from prose; it reads only the
// machine-readable marker tied to an exact HEAD SHA and ignores stale reports.
describe('review result marker', () => {
  it('formats a standards PASS marker tied to an exact HEAD', () => {
    const head = 'a'.repeat(40);

    expect(
      formatReviewMarker({ axis: 'standards', model: 'mimo-v2.5', head, result: 'PASS' }),
    ).toBe(`<!-- review-result: axis=standards model=mimo-v2.5 head=${head} result=PASS -->`);
  });

  it('round-trips a spec FAIL marker without inferring from prose', () => {
    const head = 'b'.repeat(40);
    const body = [
      '## Spec review — Muse Spark 1.3 Contributor Free',
      'Reviewed HEAD: ' + head,
      'This prose claims everything passes but the marker rules.',
      formatReviewMarker({
        axis: 'spec',
        model: 'muse-spark-1.3-contributor-free',
        head,
        result: 'FAIL',
      }),
    ].join('\n');

    const markers = parseReviewMarkers(body);

    expect(markers).toEqual([
      { axis: 'spec', model: 'muse-spark-1.3-contributor-free', head, result: 'FAIL' },
    ]);
  });

  it('returns no markers when the body has no machine-readable marker', () => {
    expect(parseReviewMarkers('Looks good to me. PASS!')).toEqual([]);
  });

  it('selects only reports matching the current HEAD and ignores stale HEADs', () => {
    const oldHead = '1'.repeat(40);
    const currentHead = '2'.repeat(40);
    const comments = [
      {
        body: formatReviewMarker({
          axis: 'standards',
          model: 'mimo-v2.5',
          head: oldHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        body: formatReviewMarker({
          axis: 'standards',
          model: 'mimo-v2.5',
          head: currentHead,
          result: 'FAIL',
        }),
        createdAt: '2026-01-02T00:00:00Z',
      },
      {
        body: formatReviewMarker({
          axis: 'spec',
          model: 'muse-spark-1.3-contributor-free',
          head: oldHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-03T00:00:00Z',
      },
    ];

    const selected = selectCurrentHeadReports(comments, currentHead);

    expect(selected.standards?.result).toBe('FAIL');
    expect(selected.spec).toBeUndefined();
  });

  it('ignores markers whose model is not the configured model for that axis', () => {
    const currentHead = '3'.repeat(40);
    const comments = [
      {
        body: formatReviewMarker({
          axis: 'standards',
          model: 'nemotron-3.5-lightning',
          head: currentHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-04T00:00:00Z',
      },
      {
        body: formatReviewMarker({
          axis: 'spec',
          model: 'mimo-v2.5',
          head: currentHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-05T00:00:00Z',
      },
    ];

    expect(selectCurrentHeadReports(comments, currentHead)).toEqual({});
  });

  it('rejects stale Nemotron, DeepSeek and North spec markers once the axis requires Muse Spark', () => {
    const currentHead = '4'.repeat(40);
    const comments = [
      {
        body: formatReviewMarker({
          axis: 'spec',
          model: 'nemotron-3.5-lightning',
          head: currentHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-06T00:00:00Z',
      },
      {
        body: formatReviewMarker({
          axis: 'spec',
          model: 'nemotron-3-ultra',
          head: currentHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-06T01:00:00Z',
      },
      {
        body: formatReviewMarker({
          axis: 'spec',
          model: 'deepseek-v4-flash-free',
          head: currentHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-06T02:00:00Z',
      },
      {
        body: formatReviewMarker({
          axis: 'spec',
          model: 'north-mini-code-free',
          head: currentHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-06T03:00:00Z',
      },
    ];

    expect(selectCurrentHeadReports(comments, currentHead)).toEqual({});
  });

  it('accepts the Muse Spark spec marker for the current HEAD', () => {
    const currentHead = '5'.repeat(40);
    const comments = [
      {
        body: formatReviewMarker({
          axis: 'spec',
          model: 'muse-spark-1.3-contributor-free',
          head: currentHead,
          result: 'PASS',
        }),
        createdAt: '2026-01-07T00:00:00Z',
      },
    ];

    expect(selectCurrentHeadReports(comments, currentHead).spec).toMatchObject({
      model: 'muse-spark-1.3-contributor-free',
      result: 'PASS',
    });
  });
});
