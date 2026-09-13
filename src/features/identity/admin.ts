import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { createIdentityAuth } from './auth.js';
import type { AdminBootstrapResult } from './contract.js';
import { identitySchema, user } from './schema.js';

// Explicit first-administrator bootstrap (ticket #59, spec #8). The first
// administrative User is created through Better Auth's supported Admin API
// (`auth.api.createUser` with the `admin` role), never through direct SQL,
// persistence inserts, or migration-seeded credentials, so password hashing
// and engine invariants stay intact. Credentials are explicit operator
// inputs; this module defines no default password and logs nothing.
//
// Bootstrap is first-admin-wins: once any `admin`-role User exists, every
// further attempt fails closed with an explicit non-secret outcome instead
// of duplicating privileged accounts. Run it immediately after migrations on
// a fresh environment; afterwards the operation stays locked.
export interface BootstrapAdminInput {
  // Request-scoped Better Auth instance from the identity infrastructure
  // boundary (already carries the Admin plugin, policy, mailer and secret).
  readonly auth: ReturnType<typeof createIdentityAuth>;
  // Slice-owned D1 binding, used read-only to detect an already-bootstrapped
  // administrative identity. Creation itself always goes through the engine.
  readonly db: D1Database;
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

export type BootstrapAdminOutcome =
  | { readonly status: 'created'; readonly admin: AdminBootstrapResult }
  | { readonly status: 'already-bootstrapped' }
  | { readonly status: 'email-conflict' };

// Engine machine code for a duplicate email on the admin create-user path.
// Matched as a stable string, never logged or echoed: the public outcome is
// the application-owned `email-conflict` / `already-bootstrapped` union.
const ENGINE_DUPLICATE_EMAIL = 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function engineErrorCode(error: unknown): string | undefined {
  const body = asRecord(asRecord(error)?.body);
  const code = body?.code;
  return typeof code === 'string' ? code : undefined;
}

// Pure boundary mapper: engine-created users become the application-owned
// admin representation. Returns null when the payload does not carry the
// expected administrative shape so callers treat it as a defect rather than
// echo engine internals.
function toBootstrappedAdmin(payload: unknown): AdminBootstrapResult | null {
  const record = asRecord(payload);
  const id = record?.id;
  const email = record?.email;
  const role = record?.role;
  const emailVerified = record?.emailVerified;
  if (
    typeof id !== 'string' ||
    typeof email !== 'string' ||
    role !== 'admin' ||
    typeof emailVerified !== 'boolean'
  ) {
    return null;
  }
  return { id, email, role, emailVerified };
}

async function hasBootstrappedAdmin(db: D1Database): Promise<boolean> {
  const database = drizzle(db, { schema: identitySchema });
  const rows = await database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, 'admin'))
    .limit(1);
  return rows.length > 0;
}

export async function bootstrapAdminUser(
  input: BootstrapAdminInput,
): Promise<BootstrapAdminOutcome> {
  if (await hasBootstrappedAdmin(input.db)) {
    return { status: 'already-bootstrapped' };
  }
  let created: unknown;
  try {
    const result = await input.auth.api.createUser({
      body: { name: input.name, email: input.email, password: input.password, role: 'admin' },
    });
    created = (result as { user?: unknown }).user ?? result;
  } catch (error) {
    if (engineErrorCode(error) === ENGINE_DUPLICATE_EMAIL) {
      // Re-read bootstrap state so concurrent first-boot attempts still end
      // in an explicit outcome: an admin that landed first locks the rest.
      return (await hasBootstrappedAdmin(input.db))
        ? { status: 'already-bootstrapped' }
        : { status: 'email-conflict' };
    }
    throw error;
  }
  const admin = toBootstrappedAdmin(created);
  if (admin === null) {
    throw new Error('Admin bootstrap returned an unexpected engine shape.');
  }
  return { status: 'created', admin };
}
