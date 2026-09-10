export interface SafePushState {
  currentBranch: string;
  prHead: string;
  prBase: string;
  pushTarget: string;
  worktreeClean: boolean;
}

export type SafePushCheck = { ok: true } | { ok: false; reason: string };

const TICKET_BRANCH_PATTERN = /^(feat|fix|chore)\/\d+-[a-z0-9-]+$/;

export function isTicketBranch(branch: string): boolean {
  return TICKET_BRANCH_PATTERN.test(branch);
}

export function checkSafePush(state: SafePushState): SafePushCheck {
  if (state.currentBranch === 'main' || state.currentBranch === 'master') {
    return { ok: false, reason: 'refusing to push from the protected branch itself' };
  }
  if (!isTicketBranch(state.currentBranch)) {
    return { ok: false, reason: `not a ticket branch: ${state.currentBranch}` };
  }
  if (state.prHead !== state.currentBranch) {
    return {
      ok: false,
      reason: `PR head ${state.prHead} does not match current branch ${state.currentBranch}`,
    };
  }
  if (state.prBase !== 'main') {
    return { ok: false, reason: `PR base must be main, got ${state.prBase}` };
  }
  if (!state.worktreeClean) {
    return { ok: false, reason: 'worktree has uncommitted changes' };
  }
  if (state.pushTarget === 'main' || state.pushTarget.endsWith('/main')) {
    return { ok: false, reason: 'push must never target main directly' };
  }
  return { ok: true };
}
