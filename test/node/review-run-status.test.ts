import { describe, expect, it } from 'vitest';
import {
  ATTENTION_MENTION,
  formatRunStatusBody,
  isAttentionOutcome,
  type RunStatusState,
} from '../../scripts/review/run-status.js';

// Seam under test: durable run-status surface (ticket #31).
// Remote runs expose current stage and terminal outcome through GitHub without
// terminal polling. Routine updates stay silent; BLOCKED/NEEDS-DECISION/TIMEOUT
// mention the owner so GitHub Mobile pushes; bodies carry deterministic
// repository-owned metadata only, never transcripts or secrets.
function baseState(overrides: Partial<RunStatusState> = {}): RunStatusState {
  return {
    target: 'issue #31',
    runUrl: 'https://github.com/o/r/actions/runs/123',
    branch: 'ticket/31-example',
    head: 'a'.repeat(40),
    currentStage: 'Standards review',
    completedStages: ['validation', 'implementation'],
    startedAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:05:00.000Z',
    worker: 'standards',
    outcome: undefined,
    reason: undefined,
    actionRequired: undefined,
    ...overrides,
  };
}

describe('run status progression', () => {
  it('exposes target, run URL, branch, HEAD, stage, and timestamps without logs', () => {
    const body = formatRunStatusBody(baseState());

    expect(body).toContain('issue #31');
    expect(body).toContain('https://github.com/o/r/actions/runs/123');
    expect(body).toContain('ticket/31-example');
    expect(body).toContain('a'.repeat(40));
    expect(body).toContain('Standards review');
    expect(body).toContain('validation');
    expect(body).toContain('2026-09-12T00:00:00.000Z');
    expect(body).toContain('2026-09-12T00:05:00.000Z');
    expect(body).toContain('standards');
  });

  it('publishes a terminal state with outcome and concise reason', () => {
    const body = formatRunStatusBody(
      baseState({
        currentStage: 'final acceptance-ready',
        outcome: 'READY',
        reason: 'ready for final acceptance',
      }),
    );

    expect(body).toContain('READY');
    expect(body).toContain('ready for final acceptance');
  });

  it('uses explicit stage names from the ticket vocabulary', () => {
    for (const stage of [
      'validation',
      'implementation',
      'gates',
      'push',
      'PR creation',
      'Standards review',
      'Spec review',
      'exact-HEAD CI',
      'address-review',
      'final acceptance-ready',
    ]) {
      expect(formatRunStatusBody(baseState({ currentStage: stage }))).toContain(stage);
    }
  });
});

describe('run status attention mentions', () => {
  it('marks BLOCKED, NEEDS-DECISION, and TIMEOUT as attention outcomes', () => {
    expect(isAttentionOutcome('BLOCKED')).toBe(true);
    expect(isAttentionOutcome('NEEDS-DECISION')).toBe(true);
    expect(isAttentionOutcome('TIMEOUT')).toBe(true);
    expect(isAttentionOutcome('READY')).toBe(false);
    expect(isAttentionOutcome('FATAL')).toBe(false);
    expect(isAttentionOutcome(undefined)).toBe(false);
  });

  it('mentions the owner with stage, reason, and action on attention outcomes', () => {
    const body = formatRunStatusBody(
      baseState({
        currentStage: 'Standards review',
        outcome: 'TIMEOUT',
        reason: 'standards worker exceeded its bound',
        actionRequired: 'Rerun review:cycle once the runner is free.',
      }),
    );

    expect(body).toContain(ATTENTION_MENTION);
    expect(body).toContain('Standards review');
    expect(body).toContain('standards worker exceeded its bound');
    expect(body).toContain('Rerun review:cycle once the runner is free.');
  });

  it('never mentions the owner on routine in-progress updates or READY', () => {
    expect(formatRunStatusBody(baseState())).not.toContain(ATTENTION_MENTION);
    expect(
      formatRunStatusBody(baseState({ outcome: 'READY', reason: 'ready for final acceptance' })),
    ).not.toContain(ATTENTION_MENTION);
  });

  it('carries deterministic metadata only, never transcripts or secrets', () => {
    const body = formatRunStatusBody(
      baseState({ outcome: 'BLOCKED', reason: 'gates failed', actionRequired: 'Inspect CI.' }),
    );

    expect(body).not.toMatch(/ghp_/);
    expect(body).not.toMatch(/transcript/i);
    expect(body).not.toContain('verification');
  });
});
