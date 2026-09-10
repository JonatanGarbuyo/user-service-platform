import { describe, expect, it } from 'vitest';
import { axesEligibleForMarkerRetry, decideNextStep } from '../../scripts/review/cycle-policy.js';

// Seam under test: deterministic correction-loop policy (ticket #16).
// Both axes stay independent, the loop is bounded, and decision-class
// findings escalate instead of triggering code corrections.
describe('review cycle policy', () => {
  const head = 'c'.repeat(40);

  it('is ready only when both axes PASS for the current HEAD', () => {
    expect(
      decideNextStep({
        standards: { axis: 'standards', model: 'mimo-v2.5', head, result: 'PASS' },
        spec: { axis: 'spec', model: 'nemotron-3-ultra', head, result: 'PASS' },
        cycles: 0,
        maxCycles: 3,
      }).kind,
    ).toBe('ready-for-acceptance');
  });

  it('never lets one axis cancel the other: a single PASS is not ready', () => {
    const decision = decideNextStep({
      standards: { axis: 'standards', model: 'mimo-v2.5', head, result: 'PASS' },
      spec: undefined,
      cycles: 0,
      maxCycles: 3,
    });

    expect(decision.kind).toBe('awaiting-reviews');
  });

  it('routes blocking FAIL findings to address-review within the bound', () => {
    const decision = decideNextStep({
      standards: { axis: 'standards', model: 'mimo-v2.5', head, result: 'FAIL' },
      spec: { axis: 'spec', model: 'nemotron-3-ultra', head, result: 'PASS' },
      cycles: 1,
      maxCycles: 3,
    });

    expect(decision.kind).toBe('address-review');
  });

  it('stops after the bounded number of correction cycles', () => {
    const decision = decideNextStep({
      standards: { axis: 'standards', model: 'mimo-v2.5', head, result: 'FAIL' },
      spec: { axis: 'spec', model: 'nemotron-3-ultra', head, result: 'PASS' },
      cycles: 3,
      maxCycles: 3,
    });

    expect(decision.kind).toBe('cycle-limit-reached');
  });

  it('escalates NEEDS-DECISION instead of correcting code', () => {
    const decision = decideNextStep({
      standards: {
        axis: 'standards',
        model: 'mimo-v2.5',
        head,
        result: 'NEEDS-DECISION',
      },
      spec: { axis: 'spec', model: 'nemotron-3-ultra', head, result: 'PASS' },
      cycles: 0,
      maxCycles: 3,
    });

    expect(decision.kind).toBe('needs-decision');
  });
});

describe('missing-marker retry policy', () => {
  it('retries a missing axis while attempts remain', () => {
    expect(axesEligibleForMarkerRetry(['spec'], { standards: 0, spec: 0 }, 2)).toEqual(['spec']);
  });

  it('retries each missing axis independently', () => {
    expect(axesEligibleForMarkerRetry(['standards', 'spec'], { standards: 1, spec: 0 }, 2)).toEqual(
      ['standards', 'spec'],
    );
  });

  it('stops retrying an axis once its bound is reached', () => {
    expect(axesEligibleForMarkerRetry(['spec'], { standards: 0, spec: 2 }, 2)).toEqual([]);
  });

  it('never retries an axis that already reported', () => {
    expect(axesEligibleForMarkerRetry(['spec'], { standards: 5, spec: 0 }, 2)).toEqual(['spec']);
  });
});
