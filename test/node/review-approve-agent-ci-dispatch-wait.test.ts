import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'workflows',
);

describe('approve-agent-ci dispatch creation-race recovery (ticket #47)', () => {
  it('waits within bounds for a hinted action_required run instead of exiting after one empty lookup', async () => {
    const raw = await readFile(resolve(workflowsDir, 'approve-agent-ci.yml'), 'utf8');

    expect(raw).toMatch(/DISPATCH_WAIT_ATTEMPTS=1/);
    expect(raw).toMatch(/DISPATCH_WAIT_ATTEMPTS=24/);
    expect(raw).toMatch(/DISPATCH_WAIT_DELAY_SECONDS=15/);
    expect(raw).toMatch(/for \(\(ATTEMPT=1; ATTEMPT<=DISPATCH_WAIT_ATTEMPTS; ATTEMPT\+=1\)\)/);
    expect(raw).toMatch(/sleep "\$DISPATCH_WAIT_DELAY_SECONDS"/);
    expect(raw).toMatch(/HINT_PR\$HINT_SHA\$HINT_RUN/);
    expect(raw).toMatch(/MATCHED=/);
    expect(raw).toMatch(/EVALUATED_ANY="true"/);
    expect(raw).toMatch(/Hinted run did not enter action_required within/);
  });

  it('preserves canonical action_required discovery and the trusted evaluator boundary', async () => {
    const raw = await readFile(resolve(workflowsDir, 'approve-agent-ci.yml'), 'utf8');

    expect(raw).toMatch(/status=action_required/);
    expect(raw).toMatch(/\.workflow_runs\[\]/);
    expect(raw).toMatch(/scripts\/approve-agent-ci\.ts/);
    expect(raw).toMatch(/ref:\s*main/);
    expect(raw).not.toMatch(/gh\s+pr\s+checkout/i);
  });
});
