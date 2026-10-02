import { describe, expect, it } from 'vitest';
import {
  d1CreateArgs,
  d1ListArgs,
  matchExactDatabase,
  parseD1ListOutput,
} from '../../scripts/deploy/provision-d1.js';
import {
  parseWorkerDeploymentsOutput,
  workerDeploymentsListArgs,
} from '../../scripts/deploy/provision-worker.js';

const DATABASE_NAME = 'rch-rugbychampagne-user-service-sandbox-db';
const OTHER_DATABASE_NAME = 'rch-rugbychampagne-user-service-production-db';
const REMOTE_ID = 'a1b2c3d4-e5f6-4789-a3b5-c6d7e8f90a1b';
const CANARY = 'canary-provider-output-abcdef123456';

// Provisioning provider contracts (ticket #80): D1 discovery/creation and
// read-only Worker/deployment discovery go through Wrangler JSON output.
// Malformed provider responses fail closed and never leak provider output.
describe('provisioning D1 provider contract', () => {
  it('lists remote databases read-only as JSON', () => {
    expect(d1ListArgs()).toEqual(['wrangler', 'd1', 'list', '--json']);
  });

  it('creates the exact canonical database name without touching config files', () => {
    const args = d1CreateArgs(DATABASE_NAME);
    expect([...args]).toEqual(['wrangler', 'd1', 'create', DATABASE_NAME, '--update-config=false']);
    expect(args.join(' ')).not.toContain('--json');
  });

  it('parses an exact-name remote database', () => {
    const stdout = JSON.stringify([
      { uuid: 'b2c3d4e5-f607-4828-b4c5-d6e7f90a1b2c', name: OTHER_DATABASE_NAME },
      { uuid: REMOTE_ID, name: DATABASE_NAME },
    ]);
    const matches = matchExactDatabase(parseD1ListOutput(stdout), DATABASE_NAME);
    expect(matches).toEqual([{ name: DATABASE_NAME, uuid: REMOTE_ID }]);
  });

  it('reports zero matches for an unprovisioned database name', () => {
    const stdout = JSON.stringify([{ uuid: REMOTE_ID, name: OTHER_DATABASE_NAME }]);
    expect(matchExactDatabase(parseD1ListOutput(stdout), DATABASE_NAME)).toEqual([]);
  });

  it('matches by exact name only, never by prefix', () => {
    const stdout = JSON.stringify([
      { uuid: REMOTE_ID, name: 'rch-rugbychampagne-user-service-sandbox-db-extra' },
    ]);
    expect(matchExactDatabase(parseD1ListOutput(stdout), DATABASE_NAME)).toEqual([]);
  });

  it('surfaces duplicate exact-name resources for fail-closed handling', () => {
    const stdout = JSON.stringify([
      { uuid: REMOTE_ID, name: DATABASE_NAME },
      { uuid: 'b2c3d4e5-f607-4828-b4c5-d6e7f90a1b2c', name: DATABASE_NAME },
    ]);
    expect(matchExactDatabase(parseD1ListOutput(stdout), DATABASE_NAME)).toHaveLength(2);
  });

  it('rejects non-array discovery output without leaking it', () => {
    let error: unknown;
    try {
      parseD1ListOutput(JSON.stringify({ value: CANARY }));
    } catch (error_) {
      error = error_;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(CANARY);
  });

  it('rejects unparsable discovery output without leaking it', () => {
    let error: unknown;
    try {
      parseD1ListOutput(`not json ${CANARY}`);
    } catch (error_) {
      error = error_;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(CANARY);
  });

  it('drops unknown value-shaped fields from discovery entries', () => {
    const stdout = JSON.stringify([{ uuid: REMOTE_ID, name: DATABASE_NAME, value: CANARY }]);
    const parsed = parseD1ListOutput(stdout);
    expect(parsed).toEqual([{ name: DATABASE_NAME, uuid: REMOTE_ID }]);
    expect(JSON.stringify(parsed)).not.toContain(CANARY);
  });
});

// Worker discovery is read-only: provisioning reports whether the Worker is
// deployed yet and never publishes application code.
describe('provisioning Worker discovery contract', () => {
  it('lists deployments for the exact Worker name as JSON', () => {
    const worker = 'rch-rugbychampagne-user-service-sandbox';
    const args = workerDeploymentsListArgs(worker);
    expect(args).toContain(worker);
    expect(args).toContain('--json');
    expect(args.join(' ')).not.toMatch(/deploy(?!ments)|publish|upload/);
  });

  it('reports an absent Worker for an empty deployment list', () => {
    expect(parseWorkerDeploymentsOutput('[]')).toEqual({ found: false });
  });

  it('reports a deployed Worker for a non-empty deployment list', () => {
    const stdout = JSON.stringify([{ id: 'deployment-1' }]);
    expect(parseWorkerDeploymentsOutput(stdout)).toEqual({ found: true });
  });

  it('rejects unexpected Worker discovery output without leaking it', () => {
    let error: unknown;
    try {
      parseWorkerDeploymentsOutput(JSON.stringify({ value: CANARY }));
    } catch (error_) {
      error = error_;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(CANARY);
  });
});
