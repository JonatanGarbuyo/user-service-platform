import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPROVE_BOT_LOGIN,
  APPROVE_READY_LABEL,
  APPROVE_REQUIRED_CONCLUSION,
  APPROVE_TRUSTED_WORKFLOW_NAME,
  buildApproveRunArgs,
  buildPollRunsArgs,
  decideAgentCiApproval,
  evaluateAgentCiApproval,
  parsePollRunsOutput,
  parseTicketBranch,
  prBodyIdentifiesTicket,
  prIdentifiesTicket,
  prTitleIdentifiesTicket,
  type AgentCiProvenance,
} from '../../scripts/review/approve-agent-ci.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';

// Seam under test: deterministic provenance guards for auto-approving
// exact-HEAD CI on trusted agent-created PRs (ticket #44). The approver must
// fail closed unless every guard is proven from GitHub-owned metadata; PR code
// is never checked out or executed and workflow-file changes stay governed by
// the #36 trusted-publication policy.
function validProvenance(): AgentCiProvenance {
  const headSha = '9dd1bf898c1aa4139969925b75924595ef0ed09e';
  return {
    workflowName: 'ci',
    runConclusion: 'action_required',
    associatedPrCount: 1,
    prNumber: 43,
    prState: 'open',
    prBaseRef: 'main',
    prHeadRef: 'ticket/11-sign-in-and-resolve-the-current-user',
    prHeadSha: headSha,
    prAuthorLogin: 'github-actions[bot]',
    prHeadRepo: 'JonatanGarbuyo/user-service-platform',
    prBaseRepo: 'JonatanGarbuyo/user-service-platform',
    prTitle: 'Sign in and resolve the current User (#11)',
    prBody: 'Automated implementation of #11 via `npm run agent:ticket`.',
    runHeadSha: headSha,
    issueNumber: 11,
    issueState: 'open',
    issueLabels: ['ready-for-agent'],
    issueIsPullRequest: false,
    changedFiles: ['src/features/identity/route.ts', 'openapi/openapi.json'],
  };
}

describe('ticket branch parsing', () => {
  it('extracts the ticket number from a repository-owned branch', () => {
    expect(parseTicketBranch('ticket/11-sign-in-and-resolve-the-current-user')).toBe(11);
    expect(parseTicketBranch('ticket/44-auto-approve-exact-head-ci')).toBe(44);
  });

  it('rejects non-conforming branches', () => {
    expect(parseTicketBranch('main')).toBeNull();
    expect(parseTicketBranch('ticket/11')).toBeNull();
    expect(parseTicketBranch('ticket/11-')).toBeNull();
    expect(parseTicketBranch('ticket/abc-slug')).toBeNull();
    expect(parseTicketBranch('ticket/0-slug')).toBeNull();
    expect(parseTicketBranch('ticket/011-slug')).toBeNull();
    expect(parseTicketBranch('ticket/11-slug/extra')).toBeNull();
    expect(parseTicketBranch('Ticket/11-slug')).toBeNull();
    expect(parseTicketBranch('')).toBeNull();
  });
});

describe('PR identity markers', () => {
  it('requires the title to end with the ticket marker', () => {
    expect(prTitleIdentifiesTicket('Sign in and resolve the current User (#11)', 11)).toBe(true);
    expect(prTitleIdentifiesTicket('Sign in (#11) extra', 11)).toBe(false);
    expect(prTitleIdentifiesTicket('Sign in (#12)', 11)).toBe(false);
    expect(prTitleIdentifiesTicket('Sign in', 11)).toBe(false);
  });

  it('requires the body to carry the automation marker for the same ticket', () => {
    expect(
      prBodyIdentifiesTicket('Automated implementation of #11 via `npm run agent:ticket`.', 11),
    ).toBe(true);
    expect(
      prBodyIdentifiesTicket('Automated implementation of #12 via `npm run agent:ticket`.', 11),
    ).toBe(false);
    expect(prBodyIdentifiesTicket('Manual fix', 11)).toBe(false);
  });

  it('requires both title and body to identify the same ticket', () => {
    expect(
      prIdentifiesTicket(
        'Sign in and resolve the current User (#11)',
        'Automated implementation of #11 via `npm run agent:ticket`.',
        11,
      ),
    ).toBe(true);
    expect(prIdentifiesTicket('Sign in and resolve the current User (#11)', 'Manual fix', 11)).toBe(
      false,
    );
    expect(
      prIdentifiesTicket(
        'Sign in',
        'Automated implementation of #11 via `npm run agent:ticket`.',
        11,
      ),
    ).toBe(false);
  });
});

describe('agent CI approval decision', () => {
  it('approves a fully proven trusted agent run', () => {
    const decision = decideAgentCiApproval(validProvenance());

    expect(decision.approved).toBe(true);
    expect(decision.ticket).toBe(11);
  });

  it('exposes the trusted constants', () => {
    expect(APPROVE_TRUSTED_WORKFLOW_NAME).toBe('ci');
    expect(APPROVE_REQUIRED_CONCLUSION).toBe('action_required');
    expect(APPROVE_BOT_LOGIN).toBe('github-actions[bot]');
    expect(APPROVE_READY_LABEL).toBe('ready-for-agent');
  });

  it('refuses a triggering workflow that is not exactly ci', () => {
    const decision = decideAgentCiApproval({ ...validProvenance(), workflowName: 'CI' });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/workflow/i);
  });

  it('refuses conclusions other than action_required', () => {
    for (const conclusion of ['success', 'failure', 'cancelled', null]) {
      const decision = decideAgentCiApproval({ ...validProvenance(), runConclusion: conclusion });

      expect(decision.approved).toBe(false);
      expect(decision.reason).toMatch(/conclusion/i);
    }
  });

  it('refuses zero or multiple associated PRs', () => {
    for (const count of [0, 2]) {
      const decision = decideAgentCiApproval({ ...validProvenance(), associatedPrCount: count });

      expect(decision.approved).toBe(false);
      expect(decision.reason).toMatch(/exactly one/i);
    }
  });

  it('refuses closed PRs', () => {
    const decision = decideAgentCiApproval({ ...validProvenance(), prState: 'closed' });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/open/i);
  });

  it('refuses PRs not targeting main', () => {
    const decision = decideAgentCiApproval({ ...validProvenance(), prBaseRef: 'develop' });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/main/i);
  });

  it('refuses fork PRs', () => {
    const decision = decideAgentCiApproval({
      ...validProvenance(),
      prHeadRepo: 'attacker/user-service-platform',
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/fork|same-repository/i);
  });

  it('refuses PRs not authored by the automation bot', () => {
    for (const login of ['octocat', 'app/github-actions', '']) {
      const decision = decideAgentCiApproval({ ...validProvenance(), prAuthorLogin: login });

      expect(decision.approved).toBe(false);
      expect(decision.reason).toMatch(/github-actions\[bot\]/);
    }
  });

  it('refuses head branches outside the ticket convention', () => {
    const decision = decideAgentCiApproval({ ...validProvenance(), prHeadRef: 'feature/cool' });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/ticket\//i);
  });

  it('refuses when the issue number does not match the branch ticket', () => {
    const decision = decideAgentCiApproval({ ...validProvenance(), issueNumber: 12 });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/same ticket/i);
  });

  it('refuses closed issues', () => {
    const decision = decideAgentCiApproval({ ...validProvenance(), issueState: 'closed' });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/open/i);
  });

  it('refuses issues without ready-for-agent', () => {
    const decision = decideAgentCiApproval({ ...validProvenance(), issueLabels: [] });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/ready-for-agent/);
  });

  it('refuses when the corresponding number is a pull request', () => {
    const decision = decideAgentCiApproval({ ...validProvenance(), issueIsPullRequest: true });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/issue/i);
  });

  it('refuses when title/body do not identify the same ticket', () => {
    const badTitle = decideAgentCiApproval({ ...validProvenance(), prTitle: 'Manual fix' });
    const badBody = decideAgentCiApproval({ ...validProvenance(), prBody: 'Manual fix' });

    expect(badTitle.approved).toBe(false);
    expect(badTitle.reason).toMatch(/title\/body|identify/i);
    expect(badBody.approved).toBe(false);
    expect(badBody.reason).toMatch(/title\/body|identify/i);
  });

  it('refuses PRs touching workflow files and keeps #36 governance', () => {
    const decision = decideAgentCiApproval({
      ...validProvenance(),
      changedFiles: ['src/x.ts', '.github/workflows/ci.yml'],
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/workflow/);
    expect(decision.reason).toMatch(/trusted/);
  });

  it('refuses when the run HEAD differs from the PR HEAD', () => {
    const decision = decideAgentCiApproval({
      ...validProvenance(),
      runHeadSha: 'a'.repeat(40),
    });

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/HEAD/i);
  });

  it('refuses ambiguous SHAs instead of guessing', () => {
    for (const sha of ['', 'abc', 'HEAD']) {
      const decision = decideAgentCiApproval({
        ...validProvenance(),
        runHeadSha: sha,
        prHeadSha: sha,
      });

      expect(decision.approved).toBe(false);
      expect(decision.reason).toMatch(/HEAD|SHA/i);
    }
  });

  it('builds a deterministic approve API call', () => {
    expect(buildApproveRunArgs('o/r', 123)).toEqual([
      'api',
      'repos/o/r/actions/runs/123/approve',
      '--method',
      'POST',
    ]);
  });
});

describe('provenance evaluation from GitHub-owned API reads', () => {
  const HEAD_SHA = '9dd1bf898c1aa4139969925b75924595ef0ed09e';
  const REPO = 'JonatanGarbuyo/user-service-platform';

  function prPayload(files: boolean): string {
    return JSON.stringify({
      state: 'open',
      title: 'Sign in and resolve the current User (#11)',
      body: 'Automated implementation of #11 via `npm run agent:ticket`.',
      user: { login: 'github-actions[bot]' },
      base: { ref: 'main', repo: { full_name: REPO } },
      head: {
        ref: 'ticket/11-sign-in-and-resolve-the-current-user',
        sha: HEAD_SHA,
        repo: { full_name: files ? 'attacker/user-service-platform' : REPO },
      },
    });
  }

  function issuePayload(): string {
    return JSON.stringify({
      number: 11,
      state: 'open',
      labels: [{ name: 'ready-for-agent' }],
    });
  }

  function evaluatorFixture(changedFiles: string): CommandExecutor {
    return (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === `gh api repos/${REPO}/pulls/43`) {
        return Promise.resolve({ stdout: `${prPayload(false)}\n`, stderr: '' });
      }
      if (key === `gh api repos/${REPO}/issues/11`) {
        return Promise.resolve({ stdout: `${issuePayload()}\n`, stderr: '' });
      }
      if (key.startsWith(`gh api repos/${REPO}/pulls/43/files`)) {
        return Promise.resolve({ stdout: changedFiles, stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
  }

  function baseInput(prNumbers: readonly number[] = [43]) {
    return {
      repoSlug: REPO,
      runId: 34695531603,
      workflowName: 'ci',
      runConclusion: 'action_required' as const,
      runHeadSha: HEAD_SHA,
      pullRequestNumbers: prNumbers,
    };
  }

  it('approves when every GitHub-owned read proves the guards', async () => {
    const decision = await evaluateAgentCiApproval(
      evaluatorFixture('openapi/openapi.json\nsrc/features/identity/route.ts\n'),
      baseInput(),
    );

    expect(decision.approved).toBe(true);
    if (decision.approved) {
      expect(decision.ticket).toBe(11);
    }
  });

  it('refuses workflow-file PRs without guessing', async () => {
    const decision = await evaluateAgentCiApproval(
      evaluatorFixture('src/x.ts\n.github/workflows/ci.yml\n'),
      baseInput(),
    );

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/workflow/);
  });

  it('fails closed when PR provenance cannot be fetched', async () => {
    const failing: CommandExecutor = () => Promise.reject(new Error('network down'));
    const decision = await evaluateAgentCiApproval(failing, baseInput());

    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/cannot prove/i);
  });

  it('refuses before any fetch when the run is not awaiting approval', async () => {
    let calls = 0;
    const counting: CommandExecutor = () => {
      calls += 1;
      return Promise.reject(new Error('must not fetch'));
    };
    const decision = await evaluateAgentCiApproval(counting, {
      ...baseInput(),
      runConclusion: 'success',
    });

    expect(decision.approved).toBe(false);
    expect(calls).toBe(0);
  });
});

describe('scheduled poll discovery (ticket #47)', () => {
  const HEAD_SHA = '6e3430d8a924d6b271c0aaa2463f9f167e7d9cd2';

  it('queries the documented workflow_runs list with a narrow awaiting filter', () => {
    const args = buildPollRunsArgs('o/r');

    expect(args).toContain(
      'repos/o/r/actions/workflows/ci.yml/runs?status=action_required&per_page=50',
    );
    expect(args).toContain('--paginate');
    const jq = args[args.indexOf('--jq') + 1] ?? '';
    // Real REST shape is { total_count, workflow_runs: [...] }, not `.runs`.
    expect(jq).toMatch(/\.workflow_runs\[\]/);
    expect(jq).not.toMatch(/\.runs\[\]/);
  });

  it('parses concatenated multi-page line output deterministically', () => {
    // `gh api --paginate` emits each page separately; line-delimited `--jq`
    // output stays parseable when pages concatenate, unlike one JSON object.
    const stdout = [
      `34698820348 ${HEAD_SHA} ci 46`,
      '',
      `34698820349 ${'a'.repeat(40)} ci 47,48`,
      `34698820350 ${'b'.repeat(40)} ci `,
      '',
    ].join('\n');

    expect(parsePollRunsOutput(stdout)).toEqual([
      { runId: 34698820348, headSha: HEAD_SHA, workflowName: 'ci', prNumbers: [46] },
      { runId: 34698820349, headSha: 'a'.repeat(40), workflowName: 'ci', prNumbers: [47, 48] },
      { runId: 34698820350, headSha: 'b'.repeat(40), workflowName: 'ci', prNumbers: [] },
    ]);
  });

  it('treats empty poll output as no candidates and skips malformed lines closed', () => {
    expect(parsePollRunsOutput('')).toEqual([]);
    expect(parsePollRunsOutput('\n  \n')).toEqual([]);
    expect(parsePollRunsOutput('not-a-line\n')).toEqual([]);
  });

  it('leaves an ineligible polled run unapproved through the shared evaluator', async () => {
    const evaluator: CommandExecutor = (command, args) => {
      const key = `${command} ${args.join(' ')}`;
      if (key === 'gh api repos/o/r/pulls/99') {
        return Promise.resolve({
          stdout: JSON.stringify({
            state: 'open',
            title: 'Manual fix',
            body: 'Manual fix',
            user: { login: 'octocat' },
            base: { ref: 'main', repo: { full_name: 'o/r' } },
            head: { ref: 'feature/manual', sha: HEAD_SHA, repo: { full_name: 'o/r' } },
          }),
          stderr: '',
        });
      }
      throw new Error(`unexpected command in test script: ${key}`);
    };
    const decision = await evaluateAgentCiApproval(evaluator, {
      repoSlug: 'o/r',
      runId: 1,
      workflowName: 'ci',
      runConclusion: 'action_required',
      runHeadSha: HEAD_SHA,
      pullRequestNumbers: [99],
    });

    expect(decision.approved).toBe(false);
  });
});

describe('workflow permission boundaries', () => {
  const workflowsDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.github',
    'workflows',
  );

  it('grants actions:write only to the trusted approver', async () => {
    const approver = await readFile(resolve(workflowsDir, 'approve-agent-ci.yml'), 'utf8');
    const ticket = await readFile(resolve(workflowsDir, 'agent-ticket.yml'), 'utf8');
    const fixCycle = await readFile(resolve(workflowsDir, 'agent-fix-cycle.yml'), 'utf8');
    const ci = await readFile(resolve(workflowsDir, 'ci.yml'), 'utf8');

    expect(approver).toMatch(/actions\s*:\s*write/);
    expect(ticket).not.toMatch(/actions\s*:\s*write/);
    expect(fixCycle).not.toMatch(/actions\s*:\s*write/);
    expect(ci).not.toMatch(/actions\s*:\s*write/);
  });

  it('keeps every workflow without generic workflows write permission', async () => {
    for (const file of [
      'approve-agent-ci.yml',
      'agent-ticket.yml',
      'agent-fix-cycle.yml',
      'ci.yml',
    ]) {
      const raw = await readFile(resolve(workflowsDir, file), 'utf8');

      expect(raw).not.toMatch(/workflows\s*:\s*write/);
    }
  });

  it('runs the approver from workflow_run for ci without PR code checkout', async () => {
    const raw = await readFile(resolve(workflowsDir, 'approve-agent-ci.yml'), 'utf8');

    expect(raw).toMatch(/workflow_run/);
    expect(raw).toMatch(/workflows:\s*\n?\s*\[?'?ci'?\]?/);
    expect(raw).toMatch(/completed/);
    expect(raw).toMatch(/action_required/);
    // Trusted checkout of main only; never the PR head SHA or a PR checkout.
    expect(raw).toMatch(/ref:\s*main/);
    expect(raw).not.toMatch(/github\.event\.workflow_run\.head_sha/);
    expect(raw).not.toMatch(/gh\s+pr\s+checkout/i);
    // No model/provider/production secrets reach the approver or ci.
    expect(raw).not.toMatch(/OPENCODE_ZEN_API_KEY/);
    expect(raw).not.toMatch(/CLOUDFLARE/);
    expect(raw).not.toMatch(/RESEND/);
  });

  it('polls awaiting runs on a schedule without relying on the missing event (ticket #47)', async () => {
    const raw = await readFile(resolve(workflowsDir, 'approve-agent-ci.yml'), 'utf8');

    // GitHub emits no workflow_run event for the observed action_required CI
    // run, so the scheduled poll is the automatic fallback.
    expect(raw).toMatch(/schedule/);
    expect(raw).toMatch(/cron/);
    // Narrow awaiting query against the documented list-runs shape.
    expect(raw).toMatch(/status=action_required/);
    expect(raw).toMatch(/\.workflow_runs\[\]/);
    expect(raw).not.toMatch(/\.runs\[\]/);
    expect(raw).toMatch(/--paginate/);
    // Trusted boundary preserved: main checkout only, per-run provenance
    // evaluation, no PR code execution.
    expect(raw).toMatch(/ref:\s*main/);
    expect(raw).toMatch(/scripts\/approve-agent-ci\.ts/);
    expect(raw).not.toMatch(/gh\s+pr\s+checkout/i);
    expect(raw).not.toMatch(/OPENCODE_ZEN_API_KEY/);
  });

  it('keeps ci least-privilege and secret-free', async () => {
    const raw = await readFile(resolve(workflowsDir, 'ci.yml'), 'utf8');

    expect(raw).toMatch(/contents\s*:\s*read/);
    expect(raw).not.toMatch(/contents\s*:\s*write/);
    expect(raw).not.toMatch(/OPENCODE_ZEN_API_KEY/);
    expect(raw).not.toMatch(/CLOUDFLARE/);
    expect(raw).not.toMatch(/RESEND/);
  });
});
