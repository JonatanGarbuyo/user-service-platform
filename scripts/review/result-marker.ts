export type ReviewAxis = 'standards' | 'spec';
export type ReviewResult = 'PASS' | 'FAIL' | 'NEEDS-DECISION';

export interface ReviewMarker {
  axis: ReviewAxis;
  model: string;
  head: string;
  result: ReviewResult;
}

export interface ReviewComment {
  body: string;
  createdAt: string;
}

const MARKER_PATTERN =
  /<!--\s*review-result:\s*axis=(standards|spec)\s+model=([^\s]+)\s+head=([0-9a-fA-F]{40})\s+result=(PASS|FAIL|NEEDS-DECISION)\s*-->/g;

export function formatReviewMarker(marker: ReviewMarker): string {
  return `<!-- review-result: axis=${marker.axis} model=${marker.model} head=${marker.head} result=${marker.result} -->`;
}

export function parseReviewMarkers(body: string): ReviewMarker[] {
  const markers: ReviewMarker[] = [];
  MARKER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_PATTERN.exec(body)) !== null) {
    const [, axis, model, head, result] = match;
    if (
      (axis === 'standards' || axis === 'spec') &&
      typeof model === 'string' &&
      typeof head === 'string' &&
      (result === 'PASS' || result === 'FAIL' || result === 'NEEDS-DECISION')
    ) {
      markers.push({ axis, model, head, result });
    }
  }
  return markers;
}

export function expectedModelForAxis(axis: ReviewAxis): string {
  return axis === 'standards' ? 'mimo-v2.5' : 'deepseek-v4-flash-free';
}

export interface CurrentHeadReports {
  standards?: ReviewMarker & { createdAt: string };
  spec?: ReviewMarker & { createdAt: string };
}

export function selectCurrentHeadReports(
  comments: ReviewComment[],
  currentHead: string,
): CurrentHeadReports {
  const latestByAxis = new Map<ReviewAxis, ReviewMarker & { createdAt: string }>();

  for (const comment of comments) {
    for (const marker of parseReviewMarkers(comment.body)) {
      // Acceptance criterion (PR #17): an axis only counts reports from its
      // configured model family — Standards is MiMo, Spec is DeepSeek.
      if (marker.model !== expectedModelForAxis(marker.axis)) {
        continue;
      }
      const existing = latestByAxis.get(marker.axis);
      if (existing === undefined || comment.createdAt >= existing.createdAt) {
        latestByAxis.set(marker.axis, { ...marker, createdAt: comment.createdAt });
      }
    }
  }

  const selected: CurrentHeadReports = {};
  const standards = latestByAxis.get('standards');
  if (standards !== undefined) {
    if (standards.head.toLowerCase() === currentHead.toLowerCase()) {
      selected.standards = standards;
    }
  }
  const spec = latestByAxis.get('spec');
  if (spec !== undefined) {
    if (spec.head.toLowerCase() === currentHead.toLowerCase()) {
      selected.spec = spec;
    }
  }
  return selected;
}
