import { describe, expect, it } from 'vitest';
import { runAgentTicket, type AgentTicketDeps } from '../../scripts/agent/ticket-flow.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';
import { ATTENTION_MENTION, RUN_STATUS_MARKER } from '../../scripts/review/run-status.js';

// Seam under test: terminal-state publication to one durable status comment
// (ticket #31). Every reached stage PATCHes the same comment with
// deterministic metadata; READY stays silent while BLOCKED/NEEDS-DECISION/
// TIMEOUT mention the owner with stage, reason, and action required.
const MAIN_HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const ISSUE_VIEW = JSON.stringify({
  number: 10,
  title: 'Register and verify an email identity',
  state: 'OPEN',
  labels: [{ name: 'ready-for-agent' }],
});

interface Fixture {
  execute: CommandExecutor;
  runWorker: NonNullable<AgentTicketDeps['runWorker']>;
  bodies: string[];
}

function statusFixture(overrides: Record<string, unknown> = {}): Fixture {
  const bodies: string[] = [];
  const script: Record<string, unknown> = {
    'git rev-parse --abbrev-ref HEAD': 'main\n',
    'git status --porcelain': '',
    'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
    'gh issue view 10 --json number,title,state,labels': `${ISSUE_VIEW}\n`,
    'git show-ref --verify refs/heads/ticket/10-register-and-verify-an-email-identity': new Error(
      "fatal: 'refs/heads/ticket/10-register-and-verify-an-email-identity' - not a valid ref",
    ),
    'git checkout -b ticket/10-register-and-verify-an-email-identity': '',
    'npm run lint': '',
    'npm run format:check': '',
    'npm run typecheck': '',
    'npm run openapi:check': '',
    'npm run test': '',
    'npm run test:harness': '',
    [`git diff --name-only ${MAIN_HEAD}...${NEXT_HEAD} -- .github/workflows/`]: '',
    'git push -u origin ticket/10-register-and-verify-an-email-identity': '',
    'gh pr create --base main --head ticket/10-register-and-verify-an-email-identity --draft --title Register and verify an email identity (#10) --body Automated implementation of #10 via `npm run agent:ticket`.':
      'https://github.com/o/r/pull/42\n',
    'gh pr view --json number,headRefName,baseRefName,headRefOid,url':
      '{"number":42,"headRefName":"ticket/10-register-and-verify-an-email-identity","baseRefName":"main","headRefOid":"bbb","url":"https://github.com/o/r/pull/42"}\n',
    ...overrides,
  };
  let headCalls = 0;
  const execute: CommandExecutor = (command, args) => {
    if (command === 'gh' && args[0] === 'api') {
      const bodyArg = args.find((arg) => arg.startsWith('body='));
      bodies.push(bodyArg === undefined ? '' : bodyArg.slice('body='.length));
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
      headCalls += 1;
      return Promise.resolve({
        stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
        stderr: '',
      });
    }
    const key = `${command} ${args.join(' ')}`;
    const scripted = script[key];
    if (scripted instanceof Error) {
      return Promise.reject(scripted);
    }
    if (typeof scripted === 'string') {
      return Promise.resolve({ stdout: scripted, stderr: '' });
    }
    throw new Error(`unexpected command in test script: ${key}`);
  };
  const runWorker: NonNullable<AgentTicketDeps['runWorker']> = (command, args) => {
    const key = `worker ${command} ${args.join(' ')}`;
    if (key === 'worker opencode run --auto --command implement 10') {
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (key === 'worker npm run review:cycle') {
      const scripted = overrides['worker npm run review:cycle'];
      if (scripted instanceof Error) {
        return Promise.reject(scripted);
      }
      return Promise.resolve({
        stdout: 'READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n',
        stderr: '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { execute, runWorker, bodies };
}

const STATUS = {
  commentId: 999,
  repoSlug: 'o/r',
  runUrl: 'https://github.com/o/r/actions/runs/123',
};

describe('agent:ticket status publication', () => {
  it('PATCHes one status comment per reached stage and publishes READY silently', async () => {
    const fixture = statusFixture();
    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
      status: STATUS,
    });

    expect(result.exitCode).toBe(0);
    expect(fixture.bodies.length).toBeGreaterThanOrEqual(6);
    for (const body of fixture.bodies) {
      expect(body).toContain(RUN_STATUS_MARKER);
      expect(body).toContain('issue #10');
      expect(body).toContain(STATUS.runUrl);
    }
    const stages = fixture.bodies.map((body) => /Stage: (.+)/.exec(body)?.[1]);
    expect(stages).toEqual([
      'implementation',
      'gates',
      'push',
      'PR creation',
      'review',
      'final acceptance-ready',
    ]);
    const terminal = fixture.bodies.at(-1) ?? '';
    expect(terminal).toContain('READY');
    expect(terminal).not.toContain(ATTENTION_MENTION);
  });

  it('publishes TIMEOUT with an attention mention when /implement exceeds its bound', async () => {
    const timeoutError = Object.assign(
      new Error('Worker timeout: implement exceeded 1800000ms: opencode run --auto'),
      { code: 'WORKER_TIMEOUT' },
    );
    const fixture = statusFixture();
    const runWorker: NonNullable<AgentTicketDeps['runWorker']> = (command, args, label) => {
      if (label === 'implement') {
        return Promise.reject(timeoutError);
      }
      return fixture.runWorker(command, args, label);
    };
    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker,
      status: STATUS,
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    const terminal = fixture.bodies.at(-1) ?? '';
    expect(terminal).toContain('TIMEOUT');
    expect(terminal).toContain(ATTENTION_MENTION);
    expect(terminal).toContain('implementation');
  });

  it('publishes NEEDS-DECISION with an attention mention on review escalation', async () => {
    const escalation = Object.assign(new Error('npm run review:cycle failed (exit 2)'), {
      code: 2,
    });
    const fixture = statusFixture({ 'worker npm run review:cycle': escalation });
    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
      status: STATUS,
    });

    expect(result.exitCode).toBe(2);
    const terminal = fixture.bodies.at(-1) ?? '';
    expect(terminal).toContain('NEEDS-DECISION');
    expect(terminal).toContain(ATTENTION_MENTION);
  });

  it('leaves GitHub silent when no status routing is configured', async () => {
    const fixture = statusFixture();
    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
    });

    expect(result.exitCode).toBe(0);
    expect(fixture.bodies).toEqual([]);
  });
});
