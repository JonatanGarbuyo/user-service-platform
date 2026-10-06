import { describe, expect, it } from 'vitest';
import {
  buildSkillEvidence,
  collectExportToolRecords,
  collectPrimaryToolCalls,
  discoverChildSessionIds,
  evidenceContainsSentinel,
  normalizeSkillName,
  parsePrimaryToolRecord,
  skillNameFromRepoPath,
  splitStreamLines,
  type SkillEvidenceInvocation,
} from '../../scripts/review/skill-evidence.js';

// Seam under test: attributable skill-tool evidence (ticket #116).
// Streamed primary JSON chunks plus verified child session exports become
// minimal evidence with honest incomplete coverage. Tests exercise the
// observable route at this seam with fixtures shaped like the pinned
// OpenCode 1.18.30 CLI/export records; no real provider calls.
function invocation(overrides: Partial<SkillEvidenceInvocation> = {}): SkillEvidenceInvocation {
  return {
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
    expect(collected.malformed).toBe(0);
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
        input: { path: '.agents/skills/tdd/SKILL.md', offset: 1, limit: 15 },
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
