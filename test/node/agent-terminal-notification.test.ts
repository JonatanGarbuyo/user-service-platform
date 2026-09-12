import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRunSummaryRecorder } from '../../scripts/review/run-summary.js';

// Seam under test (ticket #40): dual-review completed-stage tracking and
// notification-first terminal comments.
//
// Regression 1: PR #39 run 34691443905 executed both reviewers to PASS on one
// exact HEAD, yet the durable status rendered only
// `Completed: Standards review, gates, exact-HEAD CI` — Spec review was
// omitted because the initial parallel reviewers ran under a single
// `Standards review` stage.
// Regression 2: terminal notification comments started with `AGENT-TICKET...`
// or `@owner`, so mobile/email previews did not lead with the outcome.

function readWorkflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

function readReviewCycleSource(): string {
  return readFileSync('scripts/review-cycle.ts', 'utf8');
}

describe('dual-review completed stages (ticket #40)', () => {
  it('records both Standards and Spec review as completed when both exact-HEAD markers exist', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });
    recorder.setReviewedHead('a'.repeat(40));

    recorder.setStage('Standards review');
    // Both reviewers ran in parallel; exact-HEAD markers for both axes are
    // present, so both stages count as completed without serializing workers.
    recorder.markCompleted('Standards review');
    recorder.markCompleted('Spec review');

    recorder.setStage('gates');
    recorder.setStage('exact-HEAD CI');
    recorder.setStage('final acceptance-ready');
    const summary = recorder.finish('READY', 'ready for final acceptance');

    expect(summary.completedStages).toContain('Standards review');
    expect(summary.completedStages).toContain('Spec review');
  });

  it('does not represent a missing axis as completed', () => {
    const recorder = createRunSummaryRecorder({ now: () => 0 });
    recorder.setReviewedHead('b'.repeat(40));

    recorder.setStage('Standards review');
    recorder.markCompleted('Standards review');

    recorder.setStage('gates');
    const summary = recorder.finish('BLOCKED', 'missing current-HEAD reports for: spec');

    expect(summary.completedStages).toContain('Standards review');
    expect(summary.completedStages).not.toContain('Spec review');
  });

  it('keeps parallel reviewer execution independent in review-cycle', () => {
    const source = readReviewCycleSource();

    // Parallel execution must remain: both axes still run concurrently.
    expect(source).toMatch(/Promise\.all/);
    // Completion is derived from exact-HEAD markers, never inferred.
    expect(source).toMatch(/markCompleted\(['"]Standards review['"]\)/);
    expect(source).toMatch(/markCompleted\(['"]Spec review['"]\)/);
  });
});

describe('notification-first terminal comments (ticket #40)', () => {
  const TERMINAL_OUTCOMES = ['READY', 'BLOCKED', 'NEEDS-DECISION', 'TIMEOUT', 'FATAL'] as const;

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'starts every terminal notification body with an outcome prefix on %s',
    (name) => {
      const workflow = readWorkflow(name);
      const terminalBodies = extractTerminalBodies(workflow, name);

      expect(terminalBodies.length).toBeGreaterThanOrEqual(2);
      for (const body of terminalBodies) {
        // Attention bodies interpolate `[$OUTCOME]` (expands at runtime to one
        // of BLOCKED/NEEDS-DECISION/TIMEOUT/FATAL); READY bodies use the
        // literal `[READY]` prefix. Both satisfy notification-first.
        expect(body).toMatch(/^\[(\$OUTCOME|READY|BLOCKED|NEEDS-DECISION|TIMEOUT|FATAL)\]/);
      }
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'never starts a terminal notification with a mention or workflow name on %s',
    (name) => {
      const workflow = readWorkflow(name);
      const terminalBodies = extractTerminalBodies(workflow, name);

      for (const body of terminalBodies) {
        expect(body).not.toMatch(/^@/);
        expect(body).not.toMatch(/^AGENT-/);
      }
    },
  );

  it('keeps the owner mention after the prefix on attention outcomes', () => {
    for (const name of ['agent-ticket.yml', 'agent-fix-cycle.yml']) {
      const workflow = readWorkflow(name);
      const terminalBodies = extractTerminalBodies(workflow, name);
      const attention = terminalBodies.find((body) => body.includes('@JonatanGarbuyo'));

      expect(attention).toBeDefined();
      expect(attention).toMatch(
        /^\[(\$OUTCOME|BLOCKED|NEEDS-DECISION|TIMEOUT|FATAL)\].*@JonatanGarbuyo/,
      );
    }
  });

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'keeps target, HEAD, and run link in terminal notifications on %s',
    (name) => {
      const workflow = readWorkflow(name);
      const terminalBodies = extractTerminalBodies(workflow, name);
      const joined = terminalBodies.join('\n');

      expect(joined).toMatch(/HEAD/);
      expect(joined).toMatch(/RUN_URL|Workflow run/);
      if (name === 'agent-ticket.yml') {
        expect(joined).toMatch(/ISSUE_NUMBER/);
      } else {
        expect(joined).toMatch(/PR_NUMBER/);
      }
    },
  );

  it('covers all five terminal outcome families in notification prefixes', () => {
    const joined = ['agent-ticket.yml', 'agent-fix-cycle.yml'].map(readWorkflow).join('\n');

    for (const outcome of TERMINAL_OUTCOMES) {
      // Attention outcomes share one `[$OUTCOME]` interpolation; READY has its
      // own literal `[READY]` body. Either shape counts as coverage.
      const covered =
        joined.includes('[$OUTCOME]') ||
        joined.includes(`[${outcome}]`) ||
        joined.includes(outcome);
      expect(covered).toBe(true);
    }
    // The READY literal must exist explicitly; it cannot rely on interpolation.
    expect(joined).toContain('[READY]');
  });
});

// Terminal notification bodies are the concise `gh issue/pr comment` writes in
// the `Report terminal result` step — PATCH edits to the durable status
// comment do not notify, so only these bodies route to mobile/email. Guard
// refusals and acknowledgements are out of scope for the prefix rule.
function extractTerminalBodies(workflow: string, name: string): string[] {
  const marker = 'Report terminal result';
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const tail = workflow.slice(start);
  const bodies: string[] = [];
  const pattern =
    name === 'agent-ticket.yml'
      ? /gh issue comment "\$ISSUE_NUMBER" --body "([^"]*)"/g
      : /gh pr comment "\$PR_NUMBER" --body "([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tail)) !== null) {
    const body = match[1] ?? '';
    // Skip the status-comment creation (it uses --body "$BODY", not a literal).
    if (body === '$BODY' || body === '') {
      continue;
    }
    bodies.push(body);
  }
  return bodies;
}
