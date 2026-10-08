import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ReviewAxis } from '../../scripts/review/result-marker.js';
import {
  runReviewAxesSequentially,
  type AxisTiming,
} from '../../scripts/review/review-scheduling.js';

// Seam under test: sequential review-axis scheduling (ticket #127 bounded
// execution-blocker amendment). Standards and Spec stay independent reviewers
// with their own outcomes, evidence, bounds and exact-HEAD markers; only the
// launch order is sequential so two workers never hold the shared OpenCode
// profile store concurrently.
describe('shared-profile store contention', () => {
  it('fails overlapping writers with database is locked while sequential writers complete both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-scheduling-'));
    try {
      const file = join(dir, 'shared.db');
      const setup = new DatabaseSync(file);
      setup.exec('CREATE TABLE runs(axis TEXT PRIMARY KEY, result TEXT)');
      setup.close();

      const first = new DatabaseSync(file);
      const second = new DatabaseSync(file);
      try {
        first.exec('BEGIN IMMEDIATE');
        first.prepare('INSERT INTO runs(axis, result) VALUES (?, ?)').run('standards', 'PASS');

        expect(() =>
          second.prepare('INSERT INTO runs(axis, result) VALUES (?, ?)').run('spec', 'PASS'),
        ).toThrow(/database is locked/i);

        first.exec('COMMIT');
        second.prepare('INSERT INTO runs(axis, result) VALUES (?, ?)').run('spec', 'PASS');

        const verify = new DatabaseSync(file);
        try {
          const rows = verify.prepare('SELECT axis, result FROM runs ORDER BY axis').all() as {
            axis: string;
            result: string;
          }[];
          expect(rows).toEqual([
            { axis: 'spec', result: 'PASS' },
            { axis: 'standards', result: 'PASS' },
          ]);
        } finally {
          verify.close();
        }
      } finally {
        first.close();
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runReviewAxesSequentially', () => {
  it('runs standards before spec and retains both timings', async () => {
    const order: string[] = [];
    const timings = new Map<ReviewAxis, AxisTiming>();
    const firstError = await runReviewAxesSequentially(
      ['standards', 'spec'],
      (axis) => {
        order.push(axis);
      },
      timings,
    );

    expect(firstError).toBeUndefined();
    expect(order).toEqual(['standards', 'spec']);
    const standards = timings.get('standards');
    const spec = timings.get('spec');
    expect(standards?.end).toBeGreaterThanOrEqual(standards?.start ?? 0);
    expect(spec?.end).toBeGreaterThanOrEqual(spec?.start ?? 0);
    expect(spec?.start).toBeGreaterThanOrEqual(standards?.end ?? 0);
  });

  it('does not skip spec when standards reports a logical FAIL (resolved, not thrown)', async () => {
    const seen: string[] = [];
    const timings = new Map<ReviewAxis, AxisTiming>();
    const firstError = await runReviewAxesSequentially(
      ['standards', 'spec'],
      (axis) => {
        seen.push(axis);
        // A reviewer FAIL marker resolves the worker; only infra errors reject.
      },
      timings,
    );

    expect(firstError).toBeUndefined();
    expect(seen).toEqual(['standards', 'spec']);
  });

  it('still attempts spec after a standards infrastructure error then surfaces the original error', async () => {
    const seen: string[] = [];
    const timings = new Map<ReviewAxis, AxisTiming>();
    const standardsError = new Error('standards database is locked');

    const firstError = await runReviewAxesSequentially(
      ['standards', 'spec'],
      (axis) => {
        seen.push(axis);
        if (axis === 'standards') {
          throw standardsError;
        }
      },
      timings,
    );

    expect(firstError).toBe(standardsError);
    expect(seen).toEqual(['standards', 'spec']);
    expect([...timings.keys()]).toEqual(['standards', 'spec']);
  });

  it('surfaces a spec infrastructure error after a successful standards run', async () => {
    const seen: string[] = [];
    const timings = new Map<ReviewAxis, AxisTiming>();
    const specError = new Error('spec worker failed');

    const firstError = await runReviewAxesSequentially(
      ['standards', 'spec'],
      (axis) => {
        seen.push(axis);
        if (axis === 'spec') {
          throw specError;
        }
      },
      timings,
    );

    expect(firstError).toBe(specError);
    expect(seen).toEqual(['standards', 'spec']);
    expect([...timings.keys()]).toEqual(['standards', 'spec']);
  });

  it('surfaces the first error when both axes throw without fabricating a PASS/FAIL', async () => {
    const seen: string[] = [];
    const timings = new Map<ReviewAxis, AxisTiming>();
    const standardsError = new Error('standards infra error');
    const specError = new Error('spec infra error');

    const firstError = await runReviewAxesSequentially(
      ['standards', 'spec'],
      (axis) => {
        seen.push(axis);
        if (axis === 'standards') {
          throw standardsError;
        }
        throw specError;
      },
      timings,
    );

    expect(firstError).toBe(standardsError);
    expect(seen).toEqual(['standards', 'spec']);
    expect([...timings.keys()]).toEqual(['standards', 'spec']);
  });
});
