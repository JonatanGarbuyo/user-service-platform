import type { CommandExecutor } from './runner.js';

// Durable run-status surface (ticket #31). GitHub is the durable
// execution/control surface: one status comment per agent run is updated as
// stages advance so a user can determine current stage and terminal outcome
// from mobile/web without opening runner logs or polling a process.
//
// Bodies carry deterministic repository-owned metadata only — target,
// workflow/run URL, branch, HEAD, stages, timestamps, worker, outcome/reason
// — never model transcripts, prompts, credentials, verification/reset URLs,
// or tokens. Routine updates stay silent; BLOCKED/NEEDS-DECISION/TIMEOUT
// mention the owner so GitHub Mobile pushes in addition to inbox/email.
export const ATTENTION_MENTION = '@JonatanGarbuyo';
export const RUN_STATUS_MARKER = '<!-- agent-run-status -->';
export const OWNER_LOGIN = 'JonatanGarbuyo';

export type RunStatusOutcome = 'READY' | 'BLOCKED' | 'NEEDS-DECISION' | 'TIMEOUT' | 'FATAL';

export interface RunStatusState {
  target: string;
  runUrl: string;
  branch: string;
  head: string;
  currentStage: string;
  completedStages: readonly string[];
  startedAt: string;
  updatedAt: string;
  worker?: string;
  outcome?: RunStatusOutcome;
  reason?: string;
  actionRequired?: string;
}

export function isAttentionOutcome(
  outcome: RunStatusOutcome | undefined,
): outcome is 'BLOCKED' | 'NEEDS-DECISION' | 'TIMEOUT' {
  return outcome === 'BLOCKED' || outcome === 'NEEDS-DECISION' || outcome === 'TIMEOUT';
}

function completedStagesLine(stages: readonly string[]): string {
  return stages.length === 0 ? '(none yet)' : stages.join(', ');
}

function outcomeLine(state: RunStatusState): string {
  if (state.outcome === undefined) {
    return 'Outcome: in progress';
  }
  const reason = state.reason === undefined ? '' : ` — ${state.reason}`;
  return `Outcome: ${state.outcome}${reason}`;
}

// Single deterministic body builder keeps progress/status data free of
// model-authored free-form operational state.
export function formatRunStatusBody(state: RunStatusState): string {
  const outcome = state.outcome;
  const lines = [RUN_STATUS_MARKER];
  if (isAttentionOutcome(outcome)) {
    const action = state.actionRequired ?? 'See the reason below.';
    lines.push(
      `${ATTENTION_MENTION} ${outcome}: ${state.currentStage} — ${state.reason ?? 'attention required'}. Action required: ${action}`,
      '',
    );
  }
  lines.push(
    `Target: ${state.target}`,
    `Run: ${state.runUrl}`,
    `Branch: ${state.branch}`,
    `HEAD: ${state.head}`,
    `Stage: ${state.currentStage}`,
    `Completed: ${completedStagesLine(state.completedStages)}`,
    `Started: ${state.startedAt}`,
    `Updated: ${state.updatedAt}`,
    `Worker: ${state.worker ?? '(none)'}`,
    outcomeLine(state),
  );
  if (state.actionRequired !== undefined && !isAttentionOutcome(outcome)) {
    lines.push(`Action: ${state.actionRequired}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface StatusCommentRef {
  id?: number;
  url?: string;
}

export interface RunStatusPublisher {
  createStatusComment(body: string): Promise<StatusCommentRef>;
  updateStatusComment(id: number, body: string): Promise<void>;
}

export interface StatusEnv {
  commentId: number;
  repoSlug: string;
  runUrl: string;
}

// Repository-owned status routing (ticket #31). Workflows create one durable
// status comment per run and export its id plus the run URL; scripts then
// PATCH that same comment as stages advance. Absent env means a local run:
// status stays silent and orchestration is unaffected.
export function readStatusEnv(
  env: Record<string, string | undefined> = process.env,
): StatusEnv | undefined {
  const commentId = Number.parseInt(env.AGENT_RUN_STATUS_COMMENT_ID ?? '', 10);
  const repoSlug = env.GITHUB_REPOSITORY ?? '';
  const runUrl = env.AGENT_RUN_URL ?? '';
  if (!Number.isInteger(commentId) || commentId <= 0 || repoSlug === '' || runUrl === '') {
    return undefined;
  }
  return { commentId, repoSlug, runUrl };
}

// Single `gh api` shape for status updates so tests pin the exact invocation
// and production never drifts into ad-hoc comment writes.
export function buildStatusUpdateArgs(status: StatusEnv, body: string): readonly string[] {
  return [
    'api',
    `repos/${status.repoSlug}/issues/comments/${String(status.commentId)}`,
    '--method',
    'PATCH',
    '-f',
    `body=${body}`,
  ];
}

// Best-effort publication: a refused update is reported as `false` but never
// changes the orchestration outcome or exit code.
export async function publishStatusUpdate(
  execute: CommandExecutor,
  status: StatusEnv,
  body: string,
): Promise<boolean> {
  try {
    await execute('gh', buildStatusUpdateArgs(status, body));
    return true;
  } catch {
    return false;
  }
}

function parseCommentId(stdout: string): number | undefined {
  const match = /#issuecomment-(\d+)/.exec(stdout) ?? /\/issues\/comments\/(\d+)/.exec(stdout);
  if (match === null) {
    return undefined;
  }
  const id = Number.parseInt(match[1] ?? '', 10);
  return Number.isInteger(id) ? id : undefined;
}

// GitHub-backed publisher through the injected executor seam so tests observe
// exact invocations without real `gh` subprocesses. Creation and updates use
// the same deterministic body; callers keep the comment id for the run.
export function createGhStatusPublisher(
  execute: CommandExecutor,
  options: { issue?: number; pr?: number },
): RunStatusPublisher {
  const targetArgs = (body: string): readonly string[] => {
    if (options.issue !== undefined) {
      return ['issue', 'comment', String(options.issue), '--body', body];
    }
    return ['pr', 'comment', String(options.pr ?? 0), '--body', body];
  };
  return {
    async createStatusComment(body: string): Promise<StatusCommentRef> {
      const { stdout } = await execute('gh', targetArgs(body));
      const id = parseCommentId(stdout);
      return id === undefined ? {} : { id };
    },
    async updateStatusComment(id: number, body: string): Promise<void> {
      const slug = process.env.GITHUB_REPOSITORY ?? '';
      await execute(
        'gh',
        buildStatusUpdateArgs({ commentId: id, repoSlug: slug, runUrl: '' }, body),
      );
    },
  };
}
