import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkFixCyclePr,
  checkTicketIssue,
  concurrencyGroupFor,
  isAuthorizedAssociation,
  parseAgentCommand,
} from '../../scripts/agent/command-guard.js';

// Seam under test: deterministic GitHub-comment command guard (ticket #29).
// Comment text selects only a fixed allowlist of exact commands and is never
// evaluated as shell, arguments, filenames, refs, or prompts. Authorization,
// fork/base/ref rejection, and concurrency grouping are pure and tested here
// without subprocesses; the workflows invoke the existing `agent:ticket`,
// `address-review`, `review:cycle`, and safe-push flows unchanged.
describe('agent command parsing', () => {
  it('selects /agent-ticket for the exact command', () => {
    expect(parseAgentCommand('/agent-ticket')).toBe('agent-ticket');
  });

  it('selects /agent-fix-cycle for the exact command', () => {
    expect(parseAgentCommand('/agent-fix-cycle')).toBe('agent-fix-cycle');
  });

  it('ignores surrounding whitespace around the exact command', () => {
    expect(parseAgentCommand('  /agent-ticket  \n')).toBe('agent-ticket');
  });

  it('selects the first non-empty line and never evaluates the rest', () => {
    expect(parseAgentCommand('/agent-ticket\nPlease implement this when ready')).toBe(
      'agent-ticket',
    );
  });

  it.each([
    '',
    '   ',
    'please run /agent-ticket',
    '/agent-ticket 11',
    '/agent-ticket #11',
    '/agent-ticket --help',
    '/agent-fix-cycle 28',
    '/agent-fix-cycle --pr 28',
    '/agent-ticket; rm -rf /',
    '$(/agent-ticket)',
    '`/agent-ticket`',
    '/agent-ticketExtra',
    '/agent-fix-cycle-extra',
    '/agent-fix-cycle\n/agent-ticket',
  ])('refuses non-exact command text %s', (body) => {
    expect(parseAgentCommand(body)).toBeUndefined();
  });

  it('is case-sensitive', () => {
    expect(parseAgentCommand('/Agent-Ticket')).toBeUndefined();
  });
});

describe('agent command authorization', () => {
  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('authorizes %s actors', (association) => {
    expect(isAuthorizedAssociation(association)).toBe(true);
  });

  it.each([
    'CONTRIBUTOR',
    'CONTRIBUTOR ',
    'FIRST_TIMER',
    'FIRST_TIME_CONTRIBUTOR',
    'NONE',
    '',
    'owner',
    'member',
    'collaborator',
  ])('refuses non-member association %s', (association) => {
    expect(isAuthorizedAssociation(association)).toBe(false);
  });
});

describe('agent-fix-cycle safety boundaries', () => {
  const valid = {
    isPullRequest: true,
    state: 'OPEN',
    isFork: false,
    baseRef: 'main',
    headSha: 'a'.repeat(40),
  };

  it('accepts an open same-repo PR targeting main with an exact HEAD', () => {
    expect(checkFixCyclePr(valid).ok).toBe(true);
  });

  it('refuses fork PRs', () => {
    const result = checkFixCyclePr({ ...valid, isFork: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/fork/i);
    }
  });

  it('refuses non-main bases', () => {
    const result = checkFixCyclePr({ ...valid, baseRef: 'staging' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/main/i);
    }
  });

  it('refuses non-PR comments', () => {
    const result = checkFixCyclePr({ ...valid, isPullRequest: false });

    expect(result.ok).toBe(false);
  });

  it('refuses closed or ambiguous PR state', () => {
    for (const state of ['CLOSED', 'MERGED', '', 'UNKNOWN']) {
      expect(checkFixCyclePr({ ...valid, state }).ok).toBe(false);
    }
  });

  it.each(['', 'abc', 'a'.repeat(39), 'z'.repeat(40), 'HEAD', 'main'])(
    'refuses ambiguous head ref %s',
    (headSha) => {
      const result = checkFixCyclePr({ ...valid, headSha });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/head|sha|ref/i);
      }
    },
  );
});

describe('agent-ticket safety boundaries', () => {
  it('accepts an open ready-for-agent issue', () => {
    expect(
      checkTicketIssue({ isPullRequest: false, state: 'OPEN', labels: ['ready-for-agent'] }).ok,
    ).toBe(true);
  });

  it('refuses comments on pull requests', () => {
    const result = checkTicketIssue({
      isPullRequest: true,
      state: 'OPEN',
      labels: ['ready-for-agent'],
    });

    expect(result.ok).toBe(false);
  });

  it('refuses closed issues', () => {
    const result = checkTicketIssue({
      isPullRequest: false,
      state: 'CLOSED',
      labels: ['ready-for-agent'],
    });

    expect(result.ok).toBe(false);
  });

  it('refuses issues missing the ready-for-agent label', () => {
    const result = checkTicketIssue({
      isPullRequest: false,
      state: 'OPEN',
      labels: ['needs-triage'],
    });

    expect(result.ok).toBe(false);
  });
});

describe('agent command concurrency', () => {
  it('locks ticket runs by issue number', () => {
    expect(concurrencyGroupFor('agent-ticket', 11)).toBe('agent-ticket-issue-11');
  });

  it('locks fix-cycle runs by PR number', () => {
    expect(concurrencyGroupFor('agent-fix-cycle', 28)).toBe('agent-fix-cycle-pr-28');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses non-positive run numbers %s',
    (number) => {
      expect(() => concurrencyGroupFor('agent-ticket', number)).toThrow(/number/i);
    },
  );
});

function readWorkflow(name: string): string {
  return readFileSync(`.github/workflows/${name}`, 'utf8');
}

describe('agent workflow contracts', () => {
  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'triggers %s from created issue comments with per-target concurrency',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/issue_comment/);
      expect(workflow).toMatch(/created/);
      expect(workflow).toMatch(/concurrency:/);
      expect(workflow).toMatch(/cancel-in-progress:\s*false/);
    },
  );

  it('locks ticket runs by issue and fix-cycle runs by PR', () => {
    expect(readWorkflow('agent-ticket.yml')).toMatch(/agent-ticket-issue-/);
    expect(readWorkflow('agent-fix-cycle.yml')).toMatch(/agent-fix-cycle-pr-/);
  });

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'grants %s least-privilege permissions without broad write-all',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/permissions:/);
      expect(workflow).toMatch(/contents:\s*write/);
      expect(workflow).toMatch(/pull-requests:\s*write/);
      expect(workflow).toMatch(/issues:\s*write/);
      expect(workflow).not.toMatch(/pull_request_target/);
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'pins third-party actions on %s instead of mutable refs',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/actions\/checkout@v4/);
      expect(workflow).toMatch(/actions\/setup-node@v4/);
      expect(workflow).not.toMatch(/@main|@master/);
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'requires only OPENCODE_ZEN_API_KEY on %s and no production secrets',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).toMatch(/OPENCODE_ZEN_API_KEY/);
      expect(workflow).not.toMatch(/secrets\.(CLOUDFLARE|D1_|RESEND|SENDGRID|PROD_|DEPLOY_|NPM_)/i);
      expect(workflow).not.toMatch(/CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/i);
      expect(workflow).not.toMatch(/RESEND_API_KEY|SENDGRID_API_KEY|NPM_TOKEN/i);
    },
  );

  it('drives /agent-ticket through the existing agent:ticket flow', () => {
    const workflow = readWorkflow('agent-ticket.yml');

    expect(workflow).toMatch(/npm run agent:ticket/);
    expect(workflow).toMatch(/review:cycle/);
    expect(workflow).toMatch(/\.review-cycle\/latest\.json/);
  });

  it('drives /agent-fix-cycle through address-review, safe-push, and review:cycle', () => {
    const workflow = readWorkflow('agent-fix-cycle.yml');

    expect(workflow).toMatch(/address-review/);
    expect(workflow).toMatch(/safe-push/);
    expect(workflow).toMatch(/review:cycle/);
    expect(workflow).toMatch(/\.review-cycle\/latest\.json/);
  });

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'never merges, deploys, publishes, or pushes main on %s',
    (name) => {
      const workflow = readWorkflow(name).toLowerCase();

      expect(workflow).not.toContain('gh pr merge');
      expect(workflow).not.toContain('wrangler deploy');
      expect(workflow).not.toContain('npm publish');
      expect(workflow).not.toContain('push origin main');
    },
  );

  it.each(['agent-ticket.yml', 'agent-fix-cycle.yml'])(
    'never interpolates raw comment text into shell on %s',
    (name) => {
      const workflow = readWorkflow(name);

      expect(workflow).not.toMatch(/github\.event\.comment\.body/);
    },
  );
});
