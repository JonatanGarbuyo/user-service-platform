import { describe, expect, it } from 'vitest';
import {
  buildSkillEvidence,
  collectExportToolRecords,
  collectPrimaryToolCalls,
  discoverChildSessionIds,
  evidenceContainsSentinel,
  evidenceFileName,
  normalizeRepoSkillPath,
  normalizeSkillName,
  parsePrimaryToolRecord,
  serializeSkillEvidence,
  skillNameFromRepoPath,
  splitStreamLines,
  validatedSkillDir,
  type SkillEvidenceInvocation,
} from '../../scripts/review/skill-evidence.js';

// Seam under test: attributable skill-tool evidence (ticket #116).
// Streamed primary JSON chunks plus verified child session exports become
// minimal evidence with honest incomplete coverage. Tests exercise the
// observable route at this seam with fixtures shaped like the pinned
// OpenCode 1.18.30 CLI/export records; no real provider calls.
function invocation(overrides: Partial<SkillEvidenceInvocation> = {}): SkillEvidenceInvocation {
  return {
    worker: 'agent-ticket',
    command: 'implement',
    axis: 'implement',
    attempt: 1,
    workerStartHead: 'a'.repeat(40),
    githubRunId: 'unknown',
    githubRunAttempt: 'unknown',
    githubJobName: 'unknown',
    ...overrides,
  };
}

function toolLine(options: {
  session?: string;
  message?: string;
  call?: string;
  tool?: string;
  status?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): string {
  return JSON.stringify({
    type: 'tool_use',
    timestamp: 1_700_000_000_000,
    sessionID: options.session ?? 'ses-primary',
    part: {
      id: options.call ?? 'call-1',
      sessionID: options.session ?? 'ses-primary',
      messageID: options.message ?? 'msg-1',
      type: 'tool',
      tool: options.tool ?? 'skill',
      state: {
        status: options.status ?? 'completed',
        input: options.input ?? { name: 'implement' },
        metadata: options.metadata ?? { name: 'implement', dir: '.agents/skills/implement' },
      },
    },
  });
}

describe('primary tool record parsing', () => {
  it('accepts a successful skill tool call with verified metadata', () => {
    const call = parsePrimaryToolRecord(toolLine({}));

    expect(call?.tool).toBe('skill');
    expect(call?.skillName).toBe('implement');
    expect(call?.identity).toBe('ses-primary/msg-1/call-1');
  });

  it('ignores prompts, model text and tool output containing structured JSON', () => {
    expect(parsePrimaryToolRecord('not json at all')).toBeNull();
    expect(
      parsePrimaryToolRecord(
        JSON.stringify({ type: 'text', part: { text: '{"type":"tool_use"}' } }),
      ),
    ).toBeNull();
    expect(
      parsePrimaryToolRecord(
        JSON.stringify({
          type: 'tool_use',
          part: { id: 'c', sessionID: 's', messageID: 'm', type: 'tool', tool: 'bash' },
        }),
      ),
    ).toBeNull();
    expect(
      parsePrimaryToolRecord(
        JSON.stringify({
          type: 'tool_use',
          part: {
            id: 'c',
            sessionID: 's',
            messageID: 'm',
            type: 'tool',
            tool: 'skill',
            state: { status: 'completed', input: {}, metadata: {} },
          },
        }),
      ),
    ).not.toBeNull();
  });

  it('rejects skill names outside the bounded validated shape', () => {
    expect(normalizeSkillName('implement')).toBe('implement');
    expect(normalizeSkillName('Implement')).toBeNull();
    expect(normalizeSkillName('../escape')).toBeNull();
    expect(normalizeSkillName('a'.repeat(65))).toBeNull();
  });

  it('validates repo skill paths without inferring version from name', () => {
    expect(skillNameFromRepoPath('.agents/skills/tdd/SKILL.md')).toBe('tdd');
    expect(skillNameFromRepoPath('./.agents/skills/tdd/SKILL.md')).toBe('tdd');
    expect(skillNameFromRepoPath('.agents/skills/tdd/reference.md')).toBeNull();
    expect(skillNameFromRepoPath('/etc/passwd')).toBeNull();
  });

  it('splits chunked streams and reports malformed records honestly', () => {
    const buffer = { text: '' };
    const first = splitStreamLines(buffer, toolLine({ call: 'c1' }).slice(0, 20));
    expect(first).toEqual([]);
    const rest = splitStreamLines(buffer, `${toolLine({ call: 'c1' }).slice(20)}\nnot-json\n`);
    expect(rest).toHaveLength(2);
    const collected = collectPrimaryToolCalls(rest);
    expect(collected.calls).toHaveLength(1);
    // A non-JSON line in a `--format json` stream is a truncated fragment or
    // unexpected payload: never a skill source, but counted so coverage
    // cannot claim false completeness.
    expect(collected.malformed).toBe(1);
  });

  it('does not count supported irrelevant tools as malformed records', () => {
    const lines = [
      toolLine({}),
      JSON.stringify({
        type: 'tool_use',
        timestamp: 1_700_000_000_000,
        sessionID: 'ses-primary',
        part: {
          id: 'bash-1',
          sessionID: 'ses-primary',
          messageID: 'msg-1',
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'npm test' } },
        },
      }),
      JSON.stringify({ type: 'text', part: { text: 'model prose' } }),
    ];
    const collected = collectPrimaryToolCalls(lines);
    expect(collected.calls).toHaveLength(1);
    expect(collected.malformed).toBe(0);
  });
});

describe('pinned read-tool compatibility', () => {
  const ROOT = '/repo/worktree';

  function readLine(input: Record<string, unknown>, call = 'read-1'): string {
    return JSON.stringify({
      type: 'tool_use',
      timestamp: 1_700_000_000_000,
      sessionID: 'ses-primary',
      part: {
        id: call,
        sessionID: 'ses-primary',
        messageID: 'msg-3',
        type: 'tool',
        tool: 'read',
        state: { status: 'completed', input, metadata: {} },
      },
    });
  }

  it('records real absolute filePath reads normalized to the worktree', () => {
    const call = parsePrimaryToolRecord(
      readLine({ filePath: `${ROOT}/.agents/skills/tdd/SKILL.md`, offset: 1, limit: 15 }),
      ROOT,
    );

    expect(call?.tool).toBe('read');
    expect(call?.readPath).toBe('.agents/skills/tdd/SKILL.md');
    expect(call?.readOffset).toBe(1);
    expect(call?.readLimit).toBe(15);
  });

  it('rejects worktree-external absolute skill lookalikes', () => {
    const call = parsePrimaryToolRecord(
      readLine({ filePath: '/tmp/evil/.agents/skills/tdd/SKILL.md' }),
      ROOT,
    );

    expect(call?.readPath).toBeNull();
  });

  it('normalizes repo skill paths only inside the worktree', () => {
    expect(normalizeRepoSkillPath('.agents/skills/tdd/SKILL.md', ROOT)).toBe(
      '.agents/skills/tdd/SKILL.md',
    );
    expect(normalizeRepoSkillPath(`${ROOT}/.agents/skills/tdd/SKILL.md`, ROOT)).toBe(
      '.agents/skills/tdd/SKILL.md',
    );
    expect(normalizeRepoSkillPath('/tmp/evil/.agents/skills/tdd/SKILL.md', ROOT)).toBeNull();
    expect(normalizeRepoSkillPath('../escape/SKILL.md', ROOT)).toBeNull();
    expect(skillNameFromRepoPath(`${ROOT}/.agents/skills/tdd/SKILL.md`, ROOT)).toBe('tdd');
    expect(skillNameFromRepoPath('/tmp/evil/.agents/skills/tdd/SKILL.md', ROOT)).toBeNull();
  });

  it('requires exact skill-directory segments for verified provenance', () => {
    expect(validatedSkillDir('.agents/skills/implement', 'implement', ROOT)).toBe(
      '.agents/skills/implement',
    );
    expect(validatedSkillDir(`${ROOT}/.agents/skills/implement`, 'implement', ROOT)).toBe(
      `${ROOT}/.agents/skills/implement`,
    );
    // Substring lookalikes must not verify: extra segments, name suffixes
    // and worktree-external roots stay unknown.
    expect(validatedSkillDir('.agents/skills/implement-backup', 'implement', ROOT)).toBeNull();
    expect(validatedSkillDir('/tmp/x.agents/skills/implement', 'implement', ROOT)).toBeNull();
    expect(validatedSkillDir('.agents/skills/tdd', 'implement', ROOT)).toBeNull();
    expect(validatedSkillDir('anything at all', 'implement', ROOT)).toBeNull();
  });

  it('keeps spoofed skill metadata out of persisted evidence', () => {
    const spoofed = toolLine({}).replace(
      '.agents/skills/implement',
      '/tmp/evil/.agents/skills/implement-backup',
    );
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: [spoofed],
      primarySessionId: 'ses-primary',
      childExports: {},
      worktreeRoot: ROOT,
    });

    expect(record.events).toHaveLength(1);
    expect(record.events[0]?.sourceProvenance).toBe('unknown');
    expect(record.events[0]?.skillPath).toBeNull();
    expect(serializeSkillEvidence(record)).not.toContain('/tmp/evil');
  });
});

describe('child session discovery and export verification', () => {
  it('discovers children only from real task metadata, not prose', () => {
    const task = parsePrimaryToolRecord(
      toolLine({ tool: 'task', call: 't1', metadata: { sessionId: 'ses-child' } }),
    );
    expect(task?.childSessionId).toBe('ses-child');
    const discovered = discoverChildSessionIds(task === null ? [] : [task], 'ses-primary');
    expect(discovered.childIds).toEqual(['ses-child']);
  });

  it('rejects wrong-parent and unrelated exports without inclusion', () => {
    const good = {
      info: { id: 'ses-child', parentID: 'ses-primary' },
      messages: [
        {
          info: { id: 'msg-9' },
          parts: [
            {
              id: 'call-9',
              type: 'tool',
              tool: 'skill',
              state: {
                status: 'completed',
                input: { name: 'tdd' },
                metadata: { name: 'tdd', dir: '.agents/skills/tdd' },
              },
            },
          ],
        },
      ],
    };
    expect(collectExportToolRecords('ses-child', good, 'ses-primary').calls).toHaveLength(1);
    const wrong = {
      info: { id: 'ses-other', parentID: 'ses-unrelated' },
      messages: [],
    };
    const rejected = collectExportToolRecords('ses-other', wrong, 'ses-primary');
    expect(rejected.calls).toEqual([]);
    expect(rejected.reason).toMatch(/wrong parent/);
    expect(collectExportToolRecords('ses-missing', null, 'ses-primary').reason).toMatch(/missing/);
  });

  it('requires the exported identity and validates session identifiers', () => {
    const missingId = {
      info: { parentID: 'ses-primary' },
      messages: [],
    };
    expect(collectExportToolRecords('ses-child', missingId, 'ses-primary').reason).toMatch(
      /missing export id/,
    );

    const spoofedPart = {
      info: { id: 'ses-child', parentID: 'ses-primary' },
      messages: [
        {
          info: { id: 'msg-9' },
          parts: [
            {
              id: 'call-9',
              sessionID: 'ses-unrelated',
              type: 'tool',
              tool: 'skill',
              state: {
                status: 'completed',
                input: { name: 'tdd' },
                metadata: { name: 'tdd', dir: '.agents/skills/tdd' },
              },
            },
          ],
        },
      ],
    };
    const spoofed = collectExportToolRecords('ses-child', spoofedPart, 'ses-primary');
    expect(spoofed.calls).toEqual([]);
    expect(spoofed.reason).toMatch(/unverified/);
  });

  it('keeps unverified children out of lineage while marking coverage incomplete', () => {
    const primary = [
      toolLine({}),
      toolLine({
        tool: 'task',
        call: 'task-1',
        message: 'msg-2',
        metadata: { sessionId: 'ses-bad' },
      }),
    ];
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: primary,
      primarySessionId: 'ses-primary',
      childExports: {
        'ses-bad': {
          info: { id: 'ses-bad', parentID: 'ses-unrelated' },
          messages: [],
        },
      },
    });

    expect(record.coverage.status).toBe('incomplete');
    expect(record.coverage.reasons.join(' ')).toMatch(/wrong parent/);
    expect(record.coverage.childSessionIds).not.toContain('ses-bad');
    expect(record.sessionLineage.parentIds).toEqual(['ses-primary']);
  });

  it('lists verified lineage explicitly', () => {
    const primary = [
      toolLine({
        tool: 'task',
        call: 'task-1',
        message: 'msg-2',
        metadata: { sessionId: 'ses-child' },
      }),
    ];
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: primary,
      primarySessionId: 'ses-primary',
      childExports: {
        'ses-child': {
          info: { id: 'ses-child', parentID: 'ses-primary' },
          messages: [],
        },
      },
    });

    expect(record.coverage.status).toBe('complete');
    expect(record.coverage.childSessionIds).toEqual(['ses-child']);
    expect(record.sessionLineage.parentIds).toEqual(['ses-primary', 'ses-child']);
  });

  it('gives each worker invocation a distinct artifact identity', () => {
    const initial = invocation({
      worker: 'agent-fix-cycle',
      command: 'address-review',
      axis: 'address-review',
    });
    const loop = invocation({
      worker: 'review-cycle',
      command: 'address-review',
      axis: 'address-review',
    });

    expect(evidenceFileName(initial)).not.toBe(evidenceFileName(loop));
    expect(evidenceFileName(initial)).toContain('agent-fix-cycle');
    expect(evidenceFileName(loop)).toContain('review-cycle');
  });
});

describe('evidence building across the observable route', () => {
  it('merges primary and verified child records with deduplicated identities', () => {
    const primary = [
      toolLine({}),
      toolLine({}),
      toolLine({
        tool: 'task',
        call: 'task-1',
        message: 'msg-2',
        metadata: { sessionId: 'ses-child' },
      }),
      toolLine({
        tool: 'read',
        call: 'read-1',
        message: 'msg-3',
        input: { filePath: '.agents/skills/tdd/SKILL.md', offset: 1, limit: 15 },
      }),
    ];
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: primary,
      primarySessionId: 'ses-primary',
      childExports: {
        'ses-child': {
          info: { id: 'ses-child', parentID: 'ses-primary' },
          messages: [
            {
              info: { id: 'msg-c' },
              parts: [
                {
                  id: 'call-c',
                  type: 'tool',
                  tool: 'skill',
                  state: {
                    status: 'completed',
                    input: { name: 'code-review' },
                    metadata: { name: 'code-review', dir: '.agents/skills/code-review' },
                  },
                },
              ],
            },
          ],
        },
      },
    });

    const kinds = record.events.map((event) => event.kind).sort();
    expect(kinds).toEqual(['skill-file-read', 'skill-invocation', 'skill-invocation']);
    expect(record.events).toHaveLength(3);
    expect(record.coverage.status).toBe('complete');
    const read = record.events.find((event) => event.kind === 'skill-file-read');
    expect(read?.readRange).toBe('offset=1 limit=15');
    expect(read?.readFullness).toBe('partial');
    expect(read?.sourceProvenance).toBe('verified-repo-path');
  });

  it('keeps failed skill attempts and real repeats while dropping export copies', () => {
    const primary = [
      toolLine({ status: 'error', call: 'fail-1', input: { name: 'tdd' } }),
      toolLine({ call: 'ok-1', message: 'm1', input: { name: 'tdd' } }),
      toolLine({ call: 'ok-2', message: 'm2', input: { name: 'tdd' } }),
    ];
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: primary,
      primarySessionId: 'ses-primary',
      childExports: {},
    });
    const kinds = record.events.map((event) => event.kind).sort();
    expect(kinds).toEqual(['skill-attempt', 'skill-invocation', 'skill-invocation']);
  });

  it('marks unknown provenance instead of assigning current source from name', () => {
    const primary = [toolLine({ metadata: { name: 'implement' } })];
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: primary,
      primarySessionId: 'ses-primary',
      childExports: {},
    });
    expect(record.events[0]?.sourceProvenance).toBe('unknown');
  });

  it('reports incomplete coverage for truncated streams and export failures', () => {
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: [],
      primarySessionId: null,
      childExports: {},
      exportFailures: ['export timed out for session ses-child'],
      truncatedStream: true,
    });
    expect(record.coverage.status).toBe('unavailable');
    expect(record.coverage.reasons.join(' ')).toMatch(/unknown|timed out/);
  });

  it('never persists sentinel secrets in evidence', () => {
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: [toolLine({})],
      primarySessionId: 'ses-primary',
      childExports: {},
    });
    expect(evidenceContainsSentinel(record)).toBe(false);
    expect(JSON.stringify(record)).not.toContain('Loaded skill');
  });

  it('drops sentinel payloads and spoofed prose sessions at the persisted seam', () => {
    const tainted = JSON.stringify({
      type: 'tool_use',
      timestamp: 1_700_000_000_000,
      sessionID: 'ses-primary',
      part: {
        id: 'call-1',
        sessionID: 'ses-primary',
        messageID: 'msg-1',
        type: 'tool',
        tool: 'skill',
        state: {
          status: 'completed',
          input: { name: 'implement', debug: 'sk-ant-testsecret' },
          metadata: {
            name: 'implement',
            dir: '.agents/skills/implement',
            note: 'ghp_testsecret',
          },
        },
      },
    });
    // Structured-looking JSON inside model text is never a tool event, even
    // when it names a session or a skill.
    const spoofedProse = JSON.stringify({
      type: 'text',
      part: {
        text: '{"type":"tool_use","sessionID":"ses-spoofed","part":{"tool":"skill"}}',
      },
    });
    const record = buildSkillEvidence({
      invocation: invocation(),
      primaryLines: [tainted, spoofedProse],
      primarySessionId: 'ses-primary',
      childExports: {},
    });

    expect(record.events).toHaveLength(1);
    expect(evidenceContainsSentinel(record)).toBe(false);
    const serialized = serializeSkillEvidence(record);
    expect(serialized).not.toContain('sk-ant-');
    expect(serialized).not.toContain('ghp_');
    expect(serialized).not.toContain('ses-spoofed');
    expect(record.coverage.childSessionIds).not.toContain('ses-spoofed');
  });

  it('keeps concurrent axes distinct even when model text claims another axis', () => {
    const first = buildSkillEvidence({
      invocation: invocation({ command: 'review-standards', axis: 'standards', attempt: 1 }),
      primaryLines: [toolLine({})],
      primarySessionId: 'ses-standards',
      childExports: {},
    });
    const second = buildSkillEvidence({
      invocation: invocation({ command: 'review-spec', axis: 'spec', attempt: 1 }),
      primaryLines: [toolLine({})],
      primarySessionId: 'ses-spec',
      childExports: {},
    });
    expect(first.events[0]?.id).toContain('standards');
    expect(second.events[0]?.id).toContain('spec');
    expect(first.events[0]?.id).not.toBe(second.events[0]?.id);
  });
});
