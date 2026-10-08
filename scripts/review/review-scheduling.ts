import type { ReviewAxis } from './result-marker.js';

export interface AxisTiming {
  start: number;
  end: number;
}

// Sequential review-axis scheduling (ticket #127 bounded execution-blocker
// amendment). Standards and Spec remain independent reviewers with their own
// commands, evidence, bounds and exact-HEAD markers; only the launch order is
// sequential so two workers never hold the shared OpenCode profile store
// concurrently (overlapping writers fail with `database is locked`).
// Every axis is attempted even after an infrastructure error; the first error
// is surfaced unchanged so it stays an infrastructure error rather than a
// fabricated PASS/FAIL. A logical FAIL marker resolves its worker and never
// skips the other axis. Timings are recorded for every attempted axis.
export async function runReviewAxesSequentially(
  axes: readonly ReviewAxis[],
  runAxis: (axis: ReviewAxis) => Promise<void> | void,
  timings: Map<ReviewAxis, AxisTiming>,
  now: () => number = Date.now,
): Promise<unknown> {
  let firstError: unknown;
  let hasError = false;
  for (const axis of axes) {
    const start = now();
    try {
      await runAxis(axis);
      timings.set(axis, { start, end: now() });
    } catch (error) {
      timings.set(axis, { start, end: now() });
      if (!hasError) {
        firstError = error;
        hasError = true;
      }
    }
  }
  return firstError;
}
