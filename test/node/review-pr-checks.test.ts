import { describe, expect, it } from 'vitest';
import { decideStartSync } from '../../scripts/review/cycle-policy.js';
import { commitChecksPass, decideCheckPoll } from '../../scripts/review/pr-checks.js';

// Seam under test: HEAD-sync and exact-SHA CI verification (PR #17 final
// acceptance blocker 2). The loop must never report READY for a local HEAD
// that the PR/CI does not point at.
describe('review start HEAD sync', () => {
  const localHead = 'a'.repeat(40);

  it('is in sync when the PR head already matches the local HEAD', () => {
    expect(decideStartSync({ localHead, prHeadOid: localHead, push: true }).kind).toBe('in-sync');
  });

  it('pushes and refreshes when heads diverge and push is enabled', () => {
    expect(decideStartSync({ localHead, prHeadOid: 'b'.repeat(40), push: true }).kind).toBe(
      'push-and-refresh',
    );
  });

  it('aborts instead of reviewing when heads diverge under --no-push', () => {
    const decision = decideStartSync({ localHead, prHeadOid: 'b'.repeat(40), push: false });

    expect(decision.kind).toBe('abort-diverged');
  });
});

describe('exact-SHA commit checks', () => {
  it('passes when every check run completed successfully', () => {
    expect(
      commitChecksPass([
        { name: 'quality gates', status: 'completed', conclusion: 'success' },
        { name: 'quality gates', status: 'completed', conclusion: 'success' },
      ]),
    ).toBe(true);
  });

  it('fails when any check is still pending', () => {
    expect(
      commitChecksPass([
        { name: 'quality gates', status: 'completed', conclusion: 'success' },
        { name: 'quality gates', status: 'in_progress', conclusion: null },
      ]),
    ).toBe(false);
  });

  it('fails when any check concluded unsuccessfully', () => {
    expect(
      commitChecksPass([{ name: 'quality gates', status: 'completed', conclusion: 'failure' }]),
    ).toBe(false);
  });

  it('fails when no check runs are registered yet (no vacuous pass)', () => {
    expect(commitChecksPass([])).toBe(false);
  });
});

describe('check polling policy', () => {
  it('passes when every check run completed successfully', () => {
    expect(
      decideCheckPoll([{ name: 'quality gates', status: 'completed', conclusion: 'success' }]),
    ).toBe('pass');
  });

  it('waits while checks are pending or absent', () => {
    expect(decideCheckPoll([])).toBe('pending');
    expect(
      decideCheckPoll([{ name: 'quality gates', status: 'in_progress', conclusion: null }]),
    ).toBe('pending');
  });

  it('fails fast when any completed check did not succeed', () => {
    expect(
      decideCheckPoll([{ name: 'quality gates', status: 'completed', conclusion: 'failure' }]),
    ).toBe('fail');
    expect(
      decideCheckPoll([{ name: 'quality gates', status: 'completed', conclusion: null }]),
    ).toBe('fail');
  });

  it('never treats action_required as success (ticket #44)', () => {
    // Exact-HEAD CI stays authoritative: an awaiting-approval run must block
    // READY, never pass.
    expect(
      decideCheckPoll([
        { name: 'quality gates', status: 'completed', conclusion: 'action_required' },
      ]),
    ).toBe('fail');
    expect(
      commitChecksPass([
        { name: 'quality gates', status: 'completed', conclusion: 'action_required' },
      ]),
    ).toBe(false);
  });
});
