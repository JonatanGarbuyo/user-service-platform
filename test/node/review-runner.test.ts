import { describe, expect, it, vi } from 'vitest';
import { QUALITY_GATES, runQualityGates } from '../../scripts/review/gates.js';
import {
  buildAddressReviewArgs,
  buildReviewAxisArgs,
  reviewAxisWorker,
  runAddressReview,
  runReviewAxis,
} from '../../scripts/review/runner.js';

// Seam under test: deterministic worker-invocation and gate policy (PR #17
// final acceptance blockers 1 and 5, ticket #18 command ownership). Review
// workers must launch with `opencode run --auto` without `--agent`: the command
// frontmatter is the single source of truth for the configured subagent/model
// ( Standards is MiMo, Spec is Muse Spark), and gate execution order/fail-fast
// behavior must be pinned by tests, not prose.
describe('review worker invocation', () => {
  it('launches the Standards reviewer without --agent (frontmatter owns the model)', () => {
    expect(buildReviewAxisArgs('review-standards', 17)).toEqual([
      'run',
      '--auto',
      '--command',
      'review-standards',
      '17',
    ]);
  });

  it('launches the Spec reviewer without --agent (frontmatter owns the model)', () => {
    expect(buildReviewAxisArgs('review-spec', 17)).toEqual([
      'run',
      '--auto',
      '--command',
      'review-spec',
      '17',
    ]);
  });

  it('never passes --agent for review workers', () => {
    expect(buildReviewAxisArgs('review-standards', 17)).not.toContain('--agent');
    expect(buildReviewAxisArgs('review-spec', 17)).not.toContain('--agent');
    expect(buildAddressReviewArgs(17)).not.toContain('--agent');
  });

  it('launches /address-review with --auto and without --agent', () => {
    expect(buildAddressReviewArgs(17)).toEqual([
      'run',
      '--auto',
      '--command',
      'address-review',
      '17',
    ]);
  });

  it('maps each axis to its pinned worker command for targeted marker retries', () => {
    expect(reviewAxisWorker('standards')).toEqual({
      command: 'review-standards',
    });
    expect(reviewAxisWorker('spec')).toEqual({
      command: 'review-spec',
    });
  });

  it('executes the built worker command without touching subprocesses', async () => {
    const executor = vi.fn(() => Promise.resolve({ stdout: '', stderr: '' }));

    await runReviewAxis('review-standards', 17, [], executor);
    await runAddressReview(17, executor);

    expect(executor).toHaveBeenNthCalledWith(
      1,
      'opencode',
      buildReviewAxisArgs('review-standards', 17),
    );
    expect(executor).toHaveBeenNthCalledWith(2, 'opencode', buildAddressReviewArgs(17));
  });
});

describe('quality gate sequencing', () => {
  it('pins the CI-mirroring gate list and order', () => {
    expect(QUALITY_GATES.map((gate) => gate.name)).toEqual([
      'lint',
      'format:check',
      'typecheck',
      'openapi:check',
      'workers tests',
      'node/harness tests',
    ]);
  });

  it('runs every gate in order when all pass', async () => {
    const seen: string[] = [];
    const executor = vi.fn((_command: string, args: readonly string[]) => {
      seen.push(args.join(' '));
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const results = await runQualityGates(executor);

    expect(results.every((gate) => gate.ok)).toBe(true);
    expect(seen).toEqual([
      'run lint',
      'run format:check',
      'run typecheck',
      'run openapi:check',
      'run test',
      'run test:harness',
    ]);
  });

  it('stops at the first failing gate', async () => {
    const seen: string[] = [];
    const executor = vi.fn((_command: string, args: readonly string[]) => {
      seen.push(args.join(' '));
      if (args.includes('typecheck')) {
        return Promise.reject(new Error('typecheck failed'));
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const results = await runQualityGates(executor);

    expect(results.map((gate) => gate.name)).toEqual(['lint', 'format:check', 'typecheck']);
    expect(results.at(-1)?.ok).toBe(false);
    expect(seen).toEqual(['run lint', 'run format:check', 'run typecheck']);
  });
});
