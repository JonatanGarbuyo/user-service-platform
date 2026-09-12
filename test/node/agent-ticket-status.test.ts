import { describe, expect, it } from 'vitest';
import {
  TICKET_STAGE_NAMES,
  runAgentTicket,
  type AgentTicketDeps,
} from '../../scripts/agent/ticket-flow.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';

// Seam under test: durable stage progression for remote runs (ticket #31).
// `agent:ticket` advances through explicit stages (validation, implementation,
// gates, push, PR creation, review, final acceptance) and reports each stage
// so one durable status surface can be updated without terminal polling.
// Terminal outcomes distinguish TIMEOUT from other failures.
describe('agent:ticket stage progression', () => {
  it('exposes the explicit ticket stage vocabulary', () => {
    expect(TICKET_STAGE_NAMES).toEqual([
      'validation',
      'implementation',
      'gates',
      'push',
      'PR creation',
      'review',
      'final acceptance-ready',
    ]);
  });

  it('reports stages in order on the success path', async () => {
    const seen: string[] = [];
    const fixture = successFixture();
    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker: fixture.runWorker,
      onStage: (stage) => {
        seen.push(stage);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(seen).toEqual(TICKET_STAGE_NAMES);
  });

  it('reports the terminal failure stage when /implement times out', async () => {
    const seen: string[] = [];
    const fixture = successFixture();
    const timeoutError = Object.assign(
      new Error('Worker timeout: implement exceeded 1800000ms: opencode run --auto'),
      { code: 'WORKER_TIMEOUT' },
    );
    const runWorker: NonNullable<AgentTicketDeps['runWorker']> = (command, args, label) => {
      if (label === 'implement') {
        return Promise.reject(timeoutError);
      }
      return fixture.runWorker(command, args, label);
    };
    const result = await runAgentTicket('10', {
      execute: fixture.execute,
      runWorker,
      onStage: (stage) => {
        seen.push(stage);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('implement');
    expect(result.timedOut).toBe(true);
    expect(seen).toContain('implementation');
  });
});

const MAIN_HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const ISSUE_VIEW = JSON.stringify({
  number: 10,
  title: 'Register and verify an email identity',
  state: 'OPEN',
  labels: [{ name: 'ready-for-agent' }],
});

function successFixture(): {
  execute: CommandExecutor;
  runWorker: NonNullable<AgentTicketDeps['runWorker']>;
} {
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
    'git push -u origin ticket/10-register-and-verify-an-email-identity': '',
    'gh pr create --base main --head ticket/10-register-and-verify-an-email-identity --draft --title Register and verify an email identity (#10) --body Automated implementation of #10 via `npm run agent:ticket`.':
      'https://github.com/o/r/pull/42\n',
    'gh pr view --json number,headRefName,baseRefName,headRefOid,url':
      '{"number":42,"headRefName":"ticket/10-register-and-verify-an-email-identity","baseRefName":"main","headRefOid":"bbb","url":"https://github.com/o/r/pull/42"}\n',
  };
  let headCalls = 0;
  const execute: CommandExecutor = (command, args) => {
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
      return Promise.resolve({
        stdout: 'READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n',
        stderr: '',
      });
    }
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { execute, runWorker };
}
