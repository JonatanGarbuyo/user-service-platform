import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  parseFixCyclePr,
  runFixCycleCorrection,
  FIX_CYCLE_TIMEOUT_MESSAGE,
  FIX_CYCLE_TIMEOUT_SENTINEL,
} from '../../scripts/agent/fix-cycle-correction.js';
import { runAgentTicket, type AgentTicketOutcome } from '../../scripts/agent/ticket-flow.js';
import type { CommandExecutor } from '../../scripts/review/runner.js';
import {
  buildEvidenceInvocation,
  commandSessionExporter,
  createEvidenceCapture,
  finalizeSkillEvidence,
  isJsonWorkerEventLine,
  persistSkillEvidence,
  primarySessionIdFromLines,
  suppressJsonWorkerLines,
  withJsonFormat,
} from '../../scripts/review/evidence-worker.js';
import { buildSkillEvidence } from '../../scripts/review/skill-evidence.js';
import { buildAddressReviewArgs } from '../../scripts/review/runner.js';
import { runWorkerStream, type SpawnedWorker } from '../../scripts/review/worker-stream.js';

// Seam under test: evidence-capable worker routing (ticket #116).
// The initial fix-cycle correction must run through the deterministic
// evidence-capable seam, both remote upload surfaces must carry the new
// normalized evidence paths while preserving handoff files, and evidence
// finalization must never mask the worker outcome. Workflow assertions read
// the real YAML files with a real parser; commented text never satisfies.
function toolLine(call: string, session: string): string {
  return JSON.stringify({
    type: 'tool_use',
    timestamp: 1_700_000_000_000,
    sessionID: session,
    part: {
      id: call,
      sessionID: session,
      messageID: 'msg-1',
      type: 'tool',
      tool: 'skill',
      state: {
        status: 'completed',
        input: { name: 'implement' },
        metadata: { name: 'implement', dir: '.agents/skills/implement' },
      },
    },
  });
}

function readWorkflow(name: string): unknown {
  return parseYaml(readFileSync(`.github/workflows/${name}`, 'utf8')) as unknown;
}

function workflowStepRuns(doc: unknown): string[] {
  const runs: string[] = [];
  const record = doc as Record<string, unknown>;
  const jobs = record.jobs as Record<string, unknown>;
  const run = jobs.run as Record<string, unknown>;
  const steps = run.steps as Record<string, unknown>[];
  for (const step of steps) {
    if (typeof step.run === 'string') {
      runs.push(step.run);
    }
    if (typeof step.with === 'object' && step.with !== null) {
      const withBlock = step.with as Record<string, unknown>;
      if (typeof withBlock.path === 'string') {
        runs.push(`path: ${withBlock.path}`);
      }
    }
  }
  return runs;
}

describe('evidence worker invocation shape', () => {
  it('adds --format json additively without --agent or model changes', () => {
    expect(withJsonFormat(['run', '--auto', '--command', 'implement', '10'])).toEqual([
      'run',
      '--auto',
      '--command',
      'implement',
      '10',
      '--format',
      'json',
    ]);
    expect(withJsonFormat(['run', '--format', 'json'])).toEqual(['run', '--format', 'json']);
    expect(buildAddressReviewArgs(7)).toContain('--format');
    expect(buildAddressReviewArgs(7)).not.toContain('--agent');
  });

  it('attributes invocations to worker/command/axis/attempt/HEAD with unknown GitHub IDs locally', () => {
    const invocation = buildEvidenceInvocation({
      worker: 'review-cycle',
      command: 'review-standards',
      axis: 'standards',
      attempt: 2,
      workerStartHead: 'a'.repeat(40),
      env: {},
    });

    expect(invocation).toMatchObject({
      worker: 'review-cycle',
      command: 'review-standards',
      axis: 'standards',
      attempt: 2,
      githubRunId: 'unknown',
    });
  });

  it('resolves the primary session from real tool records only', () => {
    expect(primarySessionIdFromLines([toolLine('c1', 'ses-1'), 'not json'])).toBe('ses-1');
    expect(primarySessionIdFromLines(['{"type":"text"}'])).toBeNull();
  });
});

describe('evidence finalization preserves the worker outcome', () => {
  it('persists minimal evidence on success without secrets', async () => {
    const written = new Map<string, string>();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'agent-ticket',
            command: 'implement',
            axis: 'implement',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines: [toolLine('c1', 'ses-1')],
        },
        {
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );

      expect(result.evidencePath).toContain('skill-evidence');
      expect(result.record.events).toHaveLength(1);
      const raw = [...written.values()].join('\n');
      expect(raw).not.toMatch(/sk-ant-|ghp_|OPENCODE_ZEN_API_KEY/);
      expect(raw).not.toContain('Loaded skill');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('records export failures as incomplete coverage, not zero use', async () => {
    const taskLine = JSON.stringify({
      type: 'tool_use',
      sessionID: 'ses-1',
      part: {
        id: 'task-1',
        sessionID: 'ses-1',
        messageID: 'msg-2',
        type: 'tool',
        tool: 'task',
        state: { status: 'completed', metadata: { sessionId: 'ses-child' } },
      },
    });
    const result = await finalizeSkillEvidence(
      {
        invocation: buildEvidenceInvocation({
          worker: 'agent-ticket',
          command: 'implement',
          axis: 'implement',
          attempt: 1,
          workerStartHead: 'a'.repeat(40),
          env: {},
        }),
        lines: [taskLine],
        exporter: () => Promise.resolve(null),
      },
      {
        mkdir: () => Promise.resolve(),
        writeFile: () => Promise.resolve(),
      },
    );

    expect(result.record.coverage.status).toBe('incomplete');
    expect(result.record.coverage.reasons.join(' ')).toMatch(/missing export/);
  });
});

describe('fix-cycle correction seam', () => {
  it('validates the PR number without side effects', () => {
    expect(parseFixCyclePr('42')).toBe(42);
    expect(() => parseFixCyclePr('0')).toThrow(/PR number/);
    expect(() => parseFixCyclePr(undefined)).toThrow(/PR number/);
  });

  it('routes the correction through the evidence-capable worker args', async () => {
    const seen: { command: string; args: readonly string[] }[] = [];
    const finalized: string[] = [];
    const result = await runFixCycleCorrection('42', {
      runWorker: (command, args) => {
        seen.push({ command, args: [...args] });
        return Promise.resolve();
      },
      finalizeEvidence: (input) => {
        finalized.push(`${input.worker}/${input.command}/${input.axis}/${String(input.attempt)}`);
        return Promise.resolve('.agent-ticket/skill-evidence/address-review-1.json');
      },
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(0);
    expect(result.evidencePath).toContain('skill-evidence');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe('opencode');
    expect(seen[0]?.args).toEqual(buildAddressReviewArgs(42));
    expect(finalized).toEqual(['agent-fix-cycle/address-review/address-review/1']);
  });

  it('keeps a distinct timeout with the sentinel while preserving evidence', async () => {
    const { WorkerTimeoutError } = await import('../../scripts/review/worker-timeout.js');
    const written = new Map<string, string>();
    const result = await runFixCycleCorrection('42', {
      runWorker: () => {
        return Promise.reject(new WorkerTimeoutError('address-review', 1_200_000, 'opencode'));
      },
      finalizeEvidence: () => Promise.resolve(undefined),
      writeSentinel: (path, contents) => {
        written.set(path, contents);
        return Promise.resolve();
      },
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(true);
    expect(written.get(FIX_CYCLE_TIMEOUT_SENTINEL)).toBe(FIX_CYCLE_TIMEOUT_MESSAGE);
  });

  it('never lets evidence failure mask a correction failure', async () => {
    const result = await runFixCycleCorrection('42', {
      runWorker: () => Promise.reject(new Error('model blew up')),
      finalizeEvidence: () => Promise.reject(new Error('disk gone')),
      getHead: () => Promise.resolve('a'.repeat(40)),
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBeUndefined();
    expect(result.reason).toMatch(/model blew up/);
  });
});

describe('ticket implement evidence pointer', () => {
  const MAIN_HEAD = 'a'.repeat(40);
  const NEXT_HEAD = 'b'.repeat(40);
  const ISSUE_VIEW = JSON.stringify({
    number: 10,
    title: 'Register and verify an email identity',
    state: 'OPEN',
    labels: [{ name: 'ready-for-agent' }],
  });

  function evidenceScript(): Record<string, unknown> {
    return {
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
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
  }

  function evidenceDeps(script: Record<string, unknown>, implementStdout: string) {
    let headCalls = 0;
    const finalized: { command: string; axis: string; lines: number }[] = [];
    const outcomes: AgentTicketOutcome[] = [];
    const execute: CommandExecutor = (command, args) => {
      if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
        headCalls += 1;
        return Promise.resolve({
          stdout: headCalls === 1 ? `${MAIN_HEAD}\n` : `${NEXT_HEAD}\n`,
          stderr: '',
        });
      }
      if (command === 'gh' && args[0] === 'repo') {
        return Promise.resolve({ stdout: 'o/r\n', stderr: '' });
      }
      if (command === 'gh' && args[0] === 'api') {
        return Promise.resolve({ stdout: '', stderr: '' });
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
    return {
      finalized,
      outcomes,
      execute,
      runWorker: (command: string, args: readonly string[]) => {
        const key = `worker ${command} ${args.join(' ')}`;
        if (key.startsWith('worker opencode run --auto --format json --command implement')) {
          return Promise.resolve({ stdout: implementStdout, stderr: '' });
        }
        if (key === 'worker npm run review:cycle') {
          return Promise.resolve({
            stdout: 'READY FOR FINAL ACCEPTANCE\nRun summary: .review-cycle/latest.json\n',
            stderr: '',
          });
        }
        throw new Error(`unexpected worker in test script: ${key}`);
      },
      finalizeEvidence: (input: { command: string; axis: string; lines: readonly string[] }) => {
        finalized.push({ command: input.command, axis: input.axis, lines: input.lines.length });
        return Promise.resolve('.agent-ticket/skill-evidence/implement-implement-1.json');
      },
      recordOutcome: (record: AgentTicketOutcome) => {
        outcomes.push(record);
      },
    };
  }

  it('finalizes implement evidence and points the outcome record at it', async () => {
    const implementStdout = `${toolLine('c1', 'ses-1')}\n`;
    const deps = evidenceDeps(evidenceScript(), implementStdout);

    const result = await runAgentTicket('10', deps);

    expect(result.exitCode).toBe(0);
    expect(deps.finalized).toEqual([{ command: 'implement', axis: 'implement', lines: 2 }]);
    expect(deps.outcomes.at(-1)).toMatchObject({
      outcome: 'READY',
      skillEvidencePath: '.agent-ticket/skill-evidence/implement-implement-1.json',
    });
  });

  it('finalizes evidence on implement failure without masking the outcome', async () => {
    const implementStdout = '';
    const deps = evidenceDeps(evidenceScript(), implementStdout);
    const failing = {
      ...deps,
      runWorker: () => Promise.reject(new Error('boom')),
    };

    const result = await runAgentTicket('10', failing);

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('implement');
    expect(deps.finalized).toEqual([{ command: 'implement', axis: 'implement', lines: 0 }]);
    expect(deps.outcomes.at(-1)).toMatchObject({
      outcome: 'BLOCKED',
      skillEvidencePath: '.agent-ticket/skill-evidence/implement-implement-1.json',
    });
  });
});

describe('real workflow evidence wiring', () => {
  it('routes the initial fix-cycle correction through the deterministic seam', () => {
    const runs = workflowStepRuns(readWorkflow('agent-fix-cycle.yml')).join('\n');

    expect(runs).toContain('npm run agent:fix-cycle-correction');
    expect(runs).not.toContain('timeout --signal=TERM');
  });

  it('includes the normalized evidence paths on both upload surfaces', () => {
    for (const name of ['agent-ticket.yml', 'agent-fix-cycle.yml']) {
      const runs = workflowStepRuns(readWorkflow(name)).join('\n');

      expect(runs).toContain('.agent-ticket/skill-evidence/latest.json');
      expect(runs).toContain('.agent-ticket/skill-evidence/*.json');
    }
  });

  it('preserves handoff files and status contracts on both upload surfaces', () => {
    for (const name of ['agent-ticket.yml', 'agent-fix-cycle.yml']) {
      const runs = workflowStepRuns(readWorkflow(name)).join('\n');

      expect(runs).toContain('.review-cycle/latest.json');
      expect(runs).toContain('.agent-ticket/workflow-handoff.json');
      expect(runs).toContain('.agent-ticket/workflow-handoff.patch');
    }
    const ticketRuns = workflowStepRuns(readWorkflow('agent-ticket.yml')).join('\n');
    expect(ticketRuns).toContain('.agent-ticket/outcome.json');
  });
});

describe('evidence-enabled worker diagnostics', () => {
  it('classifies structured worker event lines for log suppression', () => {
    expect(isJsonWorkerEventLine(toolLine('c1', 'ses-1'))).toBe(true);
    expect(isJsonWorkerEventLine(JSON.stringify({ type: 'text', part: { text: 'hi' } }))).toBe(
      true,
    );
    expect(isJsonWorkerEventLine(JSON.stringify({ type: 'reasoning', part: {} }))).toBe(true);
    expect(isJsonWorkerEventLine('plain progress line')).toBe(false);
    expect(isJsonWorkerEventLine('')).toBe(false);
    expect(suppressJsonWorkerLines(toolLine('c1', 'ses-1'))).toBe(false);
    expect(suppressJsonWorkerLines('plain progress line')).toBe(true);
  });

  it('captures raw JSON through the spawned stream without logging payloads', async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as unknown as SpawnedWorker;
    child.stdout = stdout;
    child.stderr = stderr;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const seen: string[] = [];
      const pending = runWorkerStream(
        'opencode',
        ['run', '--auto', '--format', 'json'],
        { label: 'implement', stdoutLogFilter: suppressJsonWorkerLines },
        () => child,
        {
          onStdoutLine: (line) => {
            seen.push(line);
          },
        },
      );
      const sentinelTool = toolLine('c-sentinel', 'ses-1').replace(
        '"name":"implement"',
        '"name":"implement","debug":"sk-ant-testsecret"',
      );
      stdout.emit('data', `${sentinelTool}\nplain progress\n`);
      child.emit('close', 0);
      const result = await pending;

      // Both lines are captured for evidence, but the raw JSON payload —
      // including tool arguments — never reaches the console.
      expect(seen).toHaveLength(2);
      expect(result.stdout).toContain('plain progress');
      expect(result.stdout).toContain('c-sentinel');
      expect(logSpy).toHaveBeenCalledWith('[implement] started: opencode run --auto --format json');
      expect(logSpy).toHaveBeenCalledWith('[implement] plain progress');
      expect(logSpy).toHaveBeenCalledWith('[implement] completed (exit 0)');
      const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toContain('sk-ant-testsecret');
      expect(logged).not.toContain('c-sentinel');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('propagates capture truncation through finalization to the persisted artifact', async () => {
    const capture = createEvidenceCapture();
    capture.pushLine(toolLine('c0', 'ses-1'));
    capture.pushLine(`${toolLine('c1', 'ses-1')} ${'x'.repeat(70_000)}`);
    expect(capture.wasTruncated()).toBe(true);

    const written = new Map<string, string>();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = await finalizeSkillEvidence(
        {
          invocation: buildEvidenceInvocation({
            worker: 'review-cycle',
            command: 'review-standards',
            axis: 'standards',
            attempt: 1,
            workerStartHead: 'a'.repeat(40),
            env: {},
          }),
          lines: capture.lines,
          truncatedStream: capture.wasTruncated(),
        },
        {
          mkdir: () => Promise.resolve(),
          writeFile: (path: string, contents: string) => {
            written.set(path, contents);
            return Promise.resolve();
          },
        },
      );

      expect(result.record.coverage.status).toBe('incomplete');
      expect(result.record.coverage.reasons.join(' ')).toMatch(/truncated/);
      // The overlong line was sliced, so it no longer parses — but the bound
      // itself is reported honestly instead of claiming completeness.
      expect(result.evidencePath).toContain('review-cycle-review-standards-standards-1.json');
      const persisted = [...written.values()].join('\n');
      expect(persisted).toContain('"status": "incomplete"');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('keeps separate correction invocations in distinct artifacts', async () => {
    const written = new Map<string, string>();
    const deps = {
      mkdir: () => Promise.resolve(),
      writeFile: (path: string, contents: string) => {
        written.set(path, contents);
        return Promise.resolve();
      },
    };
    const first = await persistSkillEvidence(
      buildSkillEvidence({
        invocation: buildEvidenceInvocation({
          worker: 'agent-fix-cycle',
          command: 'address-review',
          axis: 'address-review',
          attempt: 1,
          workerStartHead: 'a'.repeat(40),
          env: {},
        }),
        primaryLines: [toolLine('c1', 'ses-1')],
        primarySessionId: 'ses-1',
        childExports: {},
      }),
      deps,
    );
    const second = await persistSkillEvidence(
      buildSkillEvidence({
        invocation: buildEvidenceInvocation({
          worker: 'review-cycle',
          command: 'address-review',
          axis: 'address-review',
          attempt: 1,
          workerStartHead: 'b'.repeat(40),
          env: {},
        }),
        primaryLines: [toolLine('c2', 'ses-2')],
        primarySessionId: 'ses-2',
        childExports: {},
      }),
      deps,
    );

    expect(first.evidencePath).not.toBe(second.evidencePath);
    expect(written.has(first.evidencePath)).toBe(true);
    expect(written.has(second.evidencePath)).toBe(true);
    expect(written.get(first.evidencePath)).toContain('c1');
    expect(written.get(second.evidencePath)).toContain('c2');
  });
});

describe('bounded session export seam', () => {
  it('treats a hung export as an honest failure and cleans up', async () => {
    const exporter = commandSessionExporter(() => new Promise<never>(() => undefined), {
      timeoutMs: 20,
    });

    const started = Date.now();
    const result = await exporter('ses-hung');
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('bounds oversized export output before parsing', async () => {
    const oversized = `${JSON.stringify({ info: { id: 'ses-big' }, messages: [] })}${' '.repeat(100)}`;
    const exporter = commandSessionExporter(
      () => Promise.resolve({ stdout: oversized, stderr: '' }),
      { maxBytes: 10 },
    );

    expect(await exporter('ses-big')).toBeNull();
  });

  it('still exports small bounded payloads', async () => {
    const payload = JSON.stringify({ info: { id: 'ses-1' }, messages: [] });
    const exporter = commandSessionExporter(() => Promise.resolve({ stdout: payload, stderr: '' }));

    expect(await exporter('ses-1')).toEqual({ info: { id: 'ses-1' }, messages: [] });
  });
});

describe('implement error finalization keeps observed evidence', () => {
  it('finalizes partial stdout attached to a worker failure without masking it', async () => {
    const { runAgentTicket } = await import('../../scripts/agent/ticket-flow.js');
    const MAIN_HEAD = 'a'.repeat(40);
    const ISSUE_VIEW = JSON.stringify({
      number: 10,
      title: 'Register and verify an email identity',
      state: 'OPEN',
      labels: [{ name: 'ready-for-agent' }],
    });
    const script: Record<string, unknown> = {
      'git rev-parse --abbrev-ref HEAD': 'main\n',
      'git status --porcelain': '',
      'git rev-parse HEAD': `${MAIN_HEAD}\n`,
      'git ls-remote origin refs/heads/main': `${MAIN_HEAD}\trefs/heads/main\n`,
      'gh issue view 10 --json number,title,state,labels': `${ISSUE_VIEW}\n`,
      'git show-ref --verify refs/heads/ticket/10-register-and-verify-an-email-identity': new Error(
        "fatal: 'refs/heads/ticket/10-register-and-verify-an-email-identity' - not a valid ref",
      ),
      'git checkout -b ticket/10-register-and-verify-an-email-identity': '',
    };
    const execute: CommandExecutor = (command, args) => {
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
    const finalized: { lines: readonly string[] }[] = [];
    const failing = Object.assign(new Error('boom'), { stdout: `${toolLine('c1', 'ses-1')}\n` });
    const result = await runAgentTicket('10', {
      execute,
      runWorker: () => Promise.reject(failing),
      finalizeEvidence: (input) => {
        finalized.push({ lines: input.lines });
        return Promise.resolve(undefined);
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.failedStage).toBe('implement');
    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.lines.join('\n')).toContain('c1');
  });
});
