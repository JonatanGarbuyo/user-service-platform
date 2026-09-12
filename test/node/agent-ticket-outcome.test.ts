import { describe, expect, it } from 'vitest';
import {
  AGENT_TICKET_OUTCOME_PATH,
  runAgentTicket,
  terminalOutcomeFor,
  writeAgentTicketOutcome,
} from '../../scripts/agent/ticket-flow.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';

// Seam under test: ticket outcome records (ticket #31).
// Every terminal state — including pre-review failures where `review:cycle`
// never ran — records its outcome, stage, and reason so the workflow terminal
// step can distinguish TIMEOUT from generic BLOCKED without log polling.
describe('agent:ticket outcome mapping', () => {
  it('maps terminal results to status outcomes with explicit stages', () => {
    expect(terminalOutcomeFor({ exitCode: 0 })).toEqual({
      outcome: 'READY',
      stage: 'final acceptance-ready',
    });
    expect(terminalOutcomeFor({ exitCode: 1, failedStage: 'implement', timedOut: true })).toEqual({
      outcome: 'TIMEOUT',
      stage: 'implementation',
    });
    expect(terminalOutcomeFor({ exitCode: 2, failedStage: 'review-cycle' })).toEqual({
      outcome: 'NEEDS-DECISION',
      stage: 'review',
    });
    expect(terminalOutcomeFor({ exitCode: 1, failedStage: 'gates' })).toEqual({
      outcome: 'BLOCKED',
      stage: 'gates',
    });
    expect(terminalOutcomeFor({ exitCode: 1, failedStage: 'start-state' })).toEqual({
      outcome: 'BLOCKED',
      stage: 'validation',
    });
  });

  it('pins the outcome record path under the repository worktree', () => {
    expect(AGENT_TICKET_OUTCOME_PATH).toBe('.agent-ticket/outcome.json');
  });

  it('writes a deterministic outcome record without transcripts or secrets', async () => {
    const written = new Map<string, string>();
    await writeAgentTicketOutcome(
      { outcome: 'TIMEOUT', stage: 'implementation', reason: 'implement timed out' },
      {
        mkdir: () => Promise.resolve(),
        writeFile: (path: string, contents: string) => {
          written.set(path, contents);
          return Promise.resolve();
        },
      },
    );

    const raw = written.get(AGENT_TICKET_OUTCOME_PATH) ?? '';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      outcome: 'TIMEOUT',
      stage: 'implementation',
      reason: 'implement timed out',
    });
    expect(raw).not.toMatch(/ghp_/);
  });
});

describe('agent:ticket early terminal publication', () => {
  it('publishes a BLOCKED terminal state when the worktree is dirty', async () => {
    const bodies: string[] = [];
    const execute: CommandExecutor = (command, args) => {
      if (command === 'gh' && args[0] === 'api') {
        const bodyArg = args.find((arg) => arg.startsWith('body='));
        bodies.push(bodyArg === undefined ? '' : bodyArg.slice('body='.length));
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (command === 'git' && args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
        return Promise.resolve({ stdout: 'main\n', stderr: '' });
      }
      if (command === 'git' && args.join(' ') === 'status --porcelain') {
        return Promise.resolve({ stdout: ' M dirty.ts\n', stderr: '' });
      }
      throw new Error(`unexpected command in test script: ${command} ${args.join(' ')}`);
    };
    const outcomeRecords: unknown[] = [];
    const result = await runAgentTicket('10', {
      execute,
      runWorker: () => Promise.resolve({ stdout: '', stderr: '' }),
      status: { commentId: 1, repoSlug: 'o/r', runUrl: 'https://github.com/o/r/actions/runs/1' },
      recordOutcome: (record) => {
        outcomeRecords.push(record);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('start-state');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('BLOCKED');
    expect(bodies[0]).toContain('@JonatanGarbuyo');
    expect(outcomeRecords).toHaveLength(1);
    expect(outcomeRecords[0]).toMatchObject({ outcome: 'BLOCKED', stage: 'validation' });
    expect(outcomeRecords[0]).toMatchObject({
      actionRequired: expect.stringContaining('rerun /agent-ticket') as unknown,
    });
  });

  it('records READY with the final stage on the success path', async () => {
    const fixture = successFixture();
    const outcomeRecords: { outcome: string; stage: string }[] = [];
    const result = await runAgentTicket('10', {
      execute: fixture,
      runWorker: (command) => {
        if (command === 'npm') {
          return Promise.resolve({
            stdout: 'READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n',
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '', stderr: '' });
      },
      recordOutcome: (record) => {
        outcomeRecords.push({ outcome: record.outcome, stage: record.stage });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(outcomeRecords).toHaveLength(1);
    expect(outcomeRecords[0]).toEqual(
      expect.objectContaining({ outcome: 'READY', stage: 'final acceptance-ready' }),
    );
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

function successFixture(): CommandExecutor {
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
  };
  let headCalls = 0;
  const execute: CommandExecutor = (command, args) => {
    if (command === 'gh' && args[0] === 'api') {
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
  return execute;
}
