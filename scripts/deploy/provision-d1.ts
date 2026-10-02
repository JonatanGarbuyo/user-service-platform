import { isProvisionedDatabaseId } from './targets.js';

// D1 provisioning provider contract (ticket #80).
//
// Discovery and creation go through Wrangler JSON output against the exact
// canonical database name:
//
// - `wrangler d1 list --json` discovers remote databases;
// - `wrangler d1 create <canonical-name> --json` creates the missing database.
//
// The repository target registry (`deploy/targets.json`), not a generated
// Wrangler file, is authoritative: creation never uses `--update-config`.
//
// Secret boundary: this module consumes database names/ids only. Failure
// messages never echo provider output, so tokens, account identifiers or
// other provider fields cannot leak through diagnostics.

export interface RemoteDatabase {
  readonly name: string;
  readonly uuid: string;
}

// Read-only remote D1 discovery invocation.
export function d1ListArgs(): readonly string[] {
  return ['wrangler', 'd1', 'list', '--json'];
}

// Exact-name D1 creation invocation. The caller validates the returned uuid
// before staging it; malformed creation responses never become accepted ids.
export function d1CreateArgs(databaseName: string): readonly string[] {
  return ['wrangler', 'd1', 'create', databaseName, '--json'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Parses the names/ids-only provider discovery output, keeping `name`/`uuid`
// pairs only. Unknown extra fields (including any value-shaped fields a
// future provider might add) are dropped, never consumed or logged.
// Non-array output fails closed with a fixed message that echoes nothing
// from the provider.
export function parseD1ListOutput(stdout: string): RemoteDatabase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('Unable to verify remote D1 databases: unexpected discovery output.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Unable to verify remote D1 databases: unexpected discovery output.');
  }
  const databases: RemoteDatabase[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      continue;
    }
    const name: unknown = entry.name;
    const uuid: unknown = entry.uuid;
    if (typeof name === 'string' && typeof uuid === 'string') {
      databases.push({ name, uuid });
    }
  }
  return databases;
}

// Matches the exact canonical database name. Matching is exact and
// case-sensitive: prefix or cross-environment names never satisfy the check,
// so one target can never adopt another target's database.
export function matchExactDatabase(
  remotes: readonly RemoteDatabase[],
  databaseName: string,
): RemoteDatabase[] {
  return remotes.filter((entry) => entry.name === databaseName);
}

// Parses the database uuid from creation output. The returned uuid is the
// provider-issued identifier; the orchestration boundary validates it with
// the same provisioned-id shape the deployer enforces before staging it.
// Output without a uuid fails closed with a fixed message that echoes
// nothing from the provider.
export function parseD1CreateOutput(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('Unable to provision the D1 database: unexpected creation output.');
  }
  if (isRecord(parsed) && typeof parsed.uuid === 'string' && parsed.uuid.length > 0) {
    return parsed.uuid;
  }
  throw new Error('Unable to provision the D1 database: unexpected creation output.');
}

// Validates a discovered or created remote id with the same provisioned-id
// shape the deployer enforces. Uniform placeholders, empty slots and
// synthetic fixtures fail closed instead of becoming accepted ids.
export function isAcceptedRemoteDatabaseId(databaseId: string): boolean {
  return isProvisionedDatabaseId(databaseId);
}
