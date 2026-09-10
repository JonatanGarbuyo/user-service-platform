import { checkSafePush } from './review/safe-push.js';
import { getCurrentBranch, getPrForBranch, isWorktreeClean, runCommand } from './review/runner.js';

// Deterministic safe-push path (ticket #16). Models never receive generic
// `git push` permission; only this script may push, and only when the current
// branch is a ticket branch, the PR head matches it, the base is `main`, the
// worktree is clean, and the push cannot target `main` itself.
async function main(): Promise<void> {
  const branch = await getCurrentBranch();
  const pr = await getPrForBranch();
  const worktreeClean = await isWorktreeClean();

  const check = checkSafePush({
    currentBranch: branch,
    prHead: pr.headRefName,
    prBase: pr.baseRefName,
    pushTarget: 'origin',
    worktreeClean,
  });

  if (!check.ok) {
    console.error(`SAFE-PUSH REFUSED: ${check.reason}`);
    console.error(`branch=${branch} prHead=${pr.headRefName} prBase=${pr.baseRefName}`);
    process.exitCode = 1;
    return;
  }

  await runCommand('git', ['push', 'origin', branch]);
  console.log(`SAFE-PUSH OK: origin/${branch} (PR #${String(pr.number)}, base main)`);
}

await main();
