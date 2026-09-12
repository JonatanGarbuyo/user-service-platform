import type { ReviewMarker } from './result-marker.js';

export const DEFAULT_MAX_CORRECTION_CYCLES = 3;
export const DEFAULT_MAX_MARKER_RETRIES = 2;

export interface CycleState {
  standards?: ReviewMarker;
  spec?: ReviewMarker;
  cycles: number;
  maxCycles: number;
}

export type CycleDecision =
  | { kind: 'ready-for-acceptance' }
  | { kind: 'address-review' }
  | { kind: 'needs-decision'; axis: 'standards' | 'spec' }
  | { kind: 'cycle-limit-reached'; cycles: number; maxCycles: number }
  | { kind: 'awaiting-reviews'; missing: ('standards' | 'spec')[] };

export interface StartSyncState {
  localHead: string;
  prHeadOid: string;
  push: boolean;
}

export type StartSyncDecision =
  { kind: 'in-sync' } | { kind: 'push-and-refresh' } | { kind: 'abort-diverged' };

// HEAD-sync policy (PR #17 final acceptance blocker 2). Review markers are
// matched against the local HEAD, so the loop must refuse to review while the
// PR still points at an older SHA: push the local HEAD first (default), or
// abort when the developer passed --no-push.
export function decideStartSync(state: StartSyncState): StartSyncDecision {
  if (state.localHead.toLowerCase() === state.prHeadOid.toLowerCase()) {
    return { kind: 'in-sync' };
  }
  if (state.push) {
    return { kind: 'push-and-refresh' };
  }
  return { kind: 'abort-diverged' };
}

export function decideNextStep(state: CycleState): CycleDecision {
  if (state.standards?.result === 'NEEDS-DECISION') {
    return { kind: 'needs-decision', axis: 'standards' };
  }
  if (state.spec?.result === 'NEEDS-DECISION') {
    return { kind: 'needs-decision', axis: 'spec' };
  }

  const missing: ('standards' | 'spec')[] = [];
  if (state.standards === undefined) {
    missing.push('standards');
  }
  if (state.spec === undefined) {
    missing.push('spec');
  }
  if (missing.length > 0) {
    return { kind: 'awaiting-reviews', missing };
  }

  // Both axes report independently; one PASS never cancels the other.
  if (state.standards?.result === 'PASS' && state.spec?.result === 'PASS') {
    return { kind: 'ready-for-acceptance' };
  }

  if (state.cycles >= state.maxCycles) {
    return { kind: 'cycle-limit-reached', cycles: state.cycles, maxCycles: state.maxCycles };
  }

  return { kind: 'address-review' };
}

export function formatReadySummary(options: {
  head: string;
  cycles: number;
  gates: 'PASS' | 'FAIL';
}): string {
  return [
    'READY FOR FINAL ACCEPTANCE',
    `HEAD: ${options.head}`,
    'Standards: PASS — MiMo',
    'Spec: PASS — Muse Spark',
    `CI/local gates: ${options.gates}`,
    `Cycles: ${String(options.cycles)}`,
  ].join('\n');
}

export type MarkerRetries = Record<'standards' | 'spec', number>;

// Missing-marker retry policy (PR #17 final acceptance blocker 1). A reviewer
// can publish a complete report yet omit its machine-readable marker; the
// orchestrator must retry only the missing axis a small bounded number of
// times instead of demanding manual intervention. Never infer results from
// prose — only a marker counts. Axes that already reported are never retried.
export function axesEligibleForMarkerRetry(
  missing: readonly ('standards' | 'spec')[],
  retries: MarkerRetries,
  maxRetries: number,
): ('standards' | 'spec')[] {
  return missing.filter((axis) => retries[axis] < maxRetries);
}
