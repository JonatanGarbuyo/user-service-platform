import { execFileSync } from 'node:child_process';

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export const GITHUB_ACTIONS_BOT_IDENTITY: GitIdentity = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
};

type GitCommandRunner = (args: readonly string[]) => void;

interface ConfigureRemoteAgentGitIdentityOptions {
  readonly githubActions?: string;
  readonly runGit?: GitCommandRunner;
}

function runGit(args: readonly string[]): void {
  execFileSync('git', args, { stdio: 'inherit' });
}

// GitHub-hosted agent-ticket runs create local commits before safe publication.
// Configure only the ephemeral repository checkout: local developer identity is
// never modified, and no credential or extra repository permission is needed.
export function configureRemoteAgentGitIdentity(
  options: ConfigureRemoteAgentGitIdentityOptions = {},
): boolean {
  const githubActions = options.githubActions ?? process.env.GITHUB_ACTIONS;
  if (githubActions !== 'true') {
    return false;
  }

  const execute = options.runGit ?? runGit;
  execute(['config', '--local', 'user.name', GITHUB_ACTIONS_BOT_IDENTITY.name]);
  execute(['config', '--local', 'user.email', GITHUB_ACTIONS_BOT_IDENTITY.email]);
  return true;
}
