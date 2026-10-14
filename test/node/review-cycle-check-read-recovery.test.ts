import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// Seam under test: the shipped review-cycle CLI (ticket #141) with controlled
// git/gh/opencode/npm fixture children on PATH. Each scenario asserts the
// real exit status, the real persisted summary, exact child-invocation counts
// and the exact queried SHA — no test-local orchestration replica. Fixture
// children validate orchestration behavior only, never model/gate success.
const REPO_ROOT = process.cwd();
const HEAD = '1234567890abcdef1234567890abcdef12345678';
const PR_NUMBER = 42;

interface CheckReadScript {
  exit: 0 | 1;
  out: string;
}

interface Scenario {
  checks: CheckReadScript[];
  workflowsOut?: string;
}

interface CycleResult {
  code: number;
  stdout: string;
  stderr: string;
  workDir: string;
  stateDir: string;
}

const passedCheck = '{"name":"quality gates","status":"completed","conclusion":"success"}\n';
const pendingCheck = '{"name":"quality gates","status":"in_progress","conclusion":null}\n';
const failedCheck = '{"name":"quality gates","status":"completed","conclusion":"failure"}\n';
const approvalCheck = '{"name":"ci","status":"completed","conclusion":"action_required"}\n';

const tmpRoots: string[] = [];

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o755);
}

function gitFixture(): string {
  return `#!/bin/sh
echo "git $*" >> "$FIXTURE_STATE/git.log"
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  printf '%s\\n' "$FIXTURE_HEAD"
  exit 0
fi
exit 0
`;
}

function ghFixture(): string {
  const prRef = String(PR_NUMBER);
  return `#!/bin/sh
echo "gh $*" >> "$FIXTURE_STATE/gh.log"
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$3" = "--json" ]; then
  printf '{"number":${prRef},"headRefName":"ticket/141-check-read-recovery","baseRefName":"main","headRefOid":"%s","url":"https://example.invalid/o/r/pull/${prRef}"}\\n' "$FIXTURE_HEAD"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  cat "$FIXTURE_STATE/comments.jsonl"
  exit 0
fi
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  printf 'o/r\\n'
  exit 0
fi
if [ "$1" = "api" ]; then
  case "$2" in
    repos/o/r/commits/*)
      sha=$(printf '%s' "$2" | sed 's#repos/o/r/commits/\\(.*\\)/check-runs#\\1#')
      printf '%s\\n' "$sha" >> "$FIXTURE_STATE/check-shas.log"
      count=$(cat "$FIXTURE_STATE/check-count")
      count=$((count + 1))
      printf '%s' "$count" > "$FIXTURE_STATE/check-count"
      code=$(cat "$FIXTURE_STATE/check-$count.exit")
      if [ "$code" != "0" ]; then
        echo "gh: failed check-runs query for $sha (fixture read error $count)" >&2
        exit 1
      fi
      cat "$FIXTURE_STATE/check-$count.out"
      exit 0
      ;;
    repos/o/r/actions/*)
      echo "gh $*" >> "$FIXTURE_STATE/workflow.log"
      cat "$FIXTURE_STATE/workflows.out"
      exit 0
      ;;
    repos/o/r/dispatches)
      echo "gh $*" >> "$FIXTURE_STATE/dispatch.log"
      exit 0
      ;;
  esac
fi
echo "gh fixture: unexpected args: $*" >&2
exit 1
`;
}

function opencodeFixture(): string {
  return `#!/bin/sh
echo "opencode $*" >> "$FIXTURE_STATE/opencode.log"
exit 0
`;
}

function npmFixture(): string {
  return `#!/bin/sh
echo "npm $*" >> "$FIXTURE_STATE/npm.log"
exit 0
`;
}

async function runScenario(scenario: Scenario): Promise<CycleResult> {
  const root = await mkdtemp(join(tmpdir(), 'ci-read-recovery-'));
  tmpRoots.push(root);
  const binDir = join(root, 'bin');
  const stateDir = join(root, 'state');
  const workDir = join(root, 'work');
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeExecutable(join(binDir, 'git'), gitFixture());
  await writeExecutable(join(binDir, 'gh'), ghFixture());
  await writeExecutable(join(binDir, 'opencode'), opencodeFixture());
  await writeExecutable(join(binDir, 'npm'), npmFixture());

  const marker = (axis: string, model: string): string =>
    `<!-- review-result: axis=${axis} model=${model} head=${HEAD} result=PASS -->`;
  const comment = {
    body: `standards review ok ${marker('standards', 'mimo-v2.6-flash')} spec review ok ${marker('spec', 'muse-spark-1.3-contributor-free')}`,
    createdAt: '2026-10-14T00:00:00.000Z',
  };
  await writeFile(join(stateDir, 'comments.jsonl'), `${JSON.stringify(comment)}\n`, 'utf8');
  await writeFile(join(stateDir, 'workflows.out'), scenario.workflowsOut ?? '', 'utf8');
  await writeFile(join(stateDir, 'check-count'), '0', 'utf8');
  for (const [index, script] of scenario.checks.entries()) {
    await writeFile(join(stateDir, `check-${String(index + 1)}.exit`), String(script.exit), 'utf8');
    await writeFile(join(stateDir, `check-${String(index + 1)}.out`), script.out, 'utf8');
  }

  const tsxBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  const cycleScript = join(REPO_ROOT, 'scripts', 'review-cycle.ts');
  try {
    const { stdout, stderr } = await execFileAsync(tsxBin, [cycleScript, '--no-bell'], {
      cwd: workDir,
      timeout: 115000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        FIXTURE_STATE: stateDir,
        FIXTURE_HEAD: HEAD,
      },
    });
    return { code: 0, stdout, stderr, workDir, stateDir };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
      workDir,
      stateDir,
    };
  }
}

async function readLines(stateDir: string, name: string): Promise<string[]> {
  try {
    const raw = await readFile(join(stateDir, name), 'utf8');
    return raw.split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [];
  }
}

async function checkReadCount(stateDir: string): Promise<number> {
  return Number.parseInt((await readFile(join(stateDir, 'check-count'), 'utf8')).trim(), 10);
}

async function readSummary(workDir: string): Promise<{
  outcome: unknown;
  detail: unknown;
  ci: unknown;
  qualityGates: unknown;
}> {
  const raw = await readFile(join(workDir, '.review-cycle', 'latest.json'), 'utf8');
  return JSON.parse(raw) as {
    outcome: unknown;
    detail: unknown;
    ci: unknown;
    qualityGates: unknown;
  };
}

async function expectExactHeadQueries(stateDir: string, expectedReads: number): Promise<void> {
  expect(await checkReadCount(stateDir)).toBe(expectedReads);
  const shas = await readLines(stateDir, 'check-shas.log');
  expect(shas).toHaveLength(expectedReads);
  for (const sha of shas) {
    expect(sha).toBe(HEAD);
  }
}

async function expectSingleReviewPass(stateDir: string): Promise<void> {
  const invocations = await readLines(stateDir, 'opencode.log');
  expect(invocations.filter((line) => line.includes('review-standards'))).toHaveLength(1);
  expect(invocations.filter((line) => line.includes('review-spec'))).toHaveLength(1);
  expect(invocations.filter((line) => line.includes('address-review'))).toHaveLength(0);
  const gates = await readLines(stateDir, 'npm.log');
  expect(gates).toEqual([
    'npm run lint',
    'npm run format:check',
    'npm run typecheck',
    'npm run openapi:check',
    'npm run test',
    'npm run test:harness',
  ]);
}

describe('review-cycle CI read recovery (ticket #141)', () => {
  it('passes immediately when the first check-run read succeeds', async () => {
    const result = await runScenario({ checks: [{ exit: 0, out: passedCheck }] });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('READY FOR FINAL ACCEPTANCE');
    const summary = await readSummary(result.workDir);
    expect(summary.outcome).toBe('READY');
    expect(summary.ci).toMatchObject({ decision: 'pass' });
    await expectExactHeadQueries(result.stateDir, 1);
    await expectSingleReviewPass(result.stateDir);
    expect(await readLines(result.stateDir, 'dispatch.log')).toHaveLength(0);
  });

  it('recovers READY after a single failed check-run read', async () => {
    const result = await runScenario({
      checks: [
        { exit: 1, out: '' },
        { exit: 0, out: passedCheck },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('READY FOR FINAL ACCEPTANCE');
    const summary = await readSummary(result.workDir);
    expect(summary.outcome).toBe('READY');
    expect(summary.ci).toMatchObject({ decision: 'pass' });
    await expectExactHeadQueries(result.stateDir, 2);
    await expectSingleReviewPass(result.stateDir);
  });

  it('recovers READY after two consecutive failed check-run reads', async () => {
    const result = await runScenario({
      checks: [
        { exit: 1, out: '' },
        { exit: 1, out: '' },
        { exit: 0, out: passedCheck },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('READY FOR FINAL ACCEPTANCE');
    const summary = await readSummary(result.workDir);
    expect(summary.outcome).toBe('READY');
    expect(summary.ci).toMatchObject({ decision: 'pass' });
    await expectExactHeadQueries(result.stateDir, 3);
    await expectSingleReviewPass(result.stateDir);
  });

  it('blocks after three consecutive failed reads without extra reviewer or gate work', async () => {
    const result = await runScenario({
      checks: [
        { exit: 1, out: '' },
        { exit: 1, out: '' },
        { exit: 1, out: '' },
      ],
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('REVIEW-CYCLE BLOCKED');
    const summary = await readSummary(result.workDir);
    expect(summary.outcome).toBe('BLOCKED');
    expect(summary.detail).toBe('cannot prove CI checks for the reviewed HEAD');
    await expectExactHeadQueries(result.stateDir, 3);
    await expectSingleReviewPass(result.stateDir);
    expect(await readLines(result.stateDir, 'dispatch.log')).toHaveLength(0);
  });

  it('fails fast when a recovered read observes genuine CI failure', async () => {
    const result = await runScenario({
      checks: [
        { exit: 1, out: '' },
        { exit: 0, out: failedCheck },
      ],
    });

    expect(result.code).not.toBe(0);
    const summary = await readSummary(result.workDir);
    expect(summary.outcome).toBe('BLOCKED');
    expect(summary.detail).toBe('CI checks for the reviewed HEAD are not successful');
    expect(summary.ci).toMatchObject({ decision: 'fail' });
    await expectExactHeadQueries(result.stateDir, 2);
    await expectSingleReviewPass(result.stateDir);
  });

  it('resets the error state across valid pending reads instead of accumulating', async () => {
    // Three failed reads separated by valid pending observations recover; a
    // non-resetting counter would block at the third error.
    const result = await runScenario({
      checks: [
        { exit: 1, out: '' },
        { exit: 0, out: pendingCheck },
        { exit: 1, out: '' },
        { exit: 0, out: pendingCheck },
        { exit: 1, out: '' },
        { exit: 0, out: passedCheck },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('READY FOR FINAL ACCEPTANCE');
    const summary = await readSummary(result.workDir);
    expect(summary.outcome).toBe('READY');
    expect(summary.ci).toMatchObject({ decision: 'pass' });
    await expectExactHeadQueries(result.stateDir, 6);
    await expectSingleReviewPass(result.stateDir);
  });

  it('waits on missing check runs instead of reporting success', async () => {
    const result = await runScenario({
      checks: [
        { exit: 0, out: '' },
        { exit: 0, out: passedCheck },
      ],
    });

    expect(result.code).toBe(0);
    const summary = await readSummary(result.workDir);
    expect(summary.outcome).toBe('READY');
    expect(summary.ci).toMatchObject({ decision: 'pass' });
    await expectExactHeadQueries(result.stateDir, 2);
  });

  it('waits on approval-waiting checks with a single approval dispatch', async () => {
    const result = await runScenario({
      checks: [
        { exit: 0, out: approvalCheck },
        { exit: 0, out: passedCheck },
      ],
    });

    expect(result.code).toBe(0);
    const summary = await readSummary(result.workDir);
    expect(summary.outcome).toBe('READY');
    await expectExactHeadQueries(result.stateDir, 2);
    await expectSingleReviewPass(result.stateDir);
    expect(await readLines(result.stateDir, 'dispatch.log')).toHaveLength(1);
  });
});
