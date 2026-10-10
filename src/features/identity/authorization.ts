import type { D1Database } from '@cloudflare/workers-types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { createIdentityAuth } from './auth.js';
import type { AdminMe } from './contract.js';
import { identitySchema, user } from './schema.js';

// Application-owned administrator authorization (ticket #124, spec #123).
// Feature slices and the administration UI never infer authorization from
// frontend state: the only signal is this boundary resolving the current
// session holder to their exact administrative representation, or null when
// they must be denied.
//
// The permission signal is the supported Better Auth admin capability
// (`auth.api.userHasPermission`) for User listing/read access, evaluated for
// the session holder behind this interface. In the current default admin
// plugin configuration the `admin` role qualifies and the default `user`
// role does not. The returned representation carries only explicitly
// selected fields; credentials, session tokens and raw persistence rows
// never cross it.
export interface AdminAuthorizationInput {
  // Request-scoped Better Auth instance from the identity infrastructure
  // boundary (already carries the Admin plugin, policy, mailer and secret).
  readonly auth: ReturnType<typeof createIdentityAuth>;
  // Slice-owned D1 binding, used read-only to project the authorized
  // administrator representation. Authorization itself is decided by the
  // engine permission capability, never by this read.
  readonly db: D1Database;
  // The already-resolved session holder. Callers resolve the session first
  // (authoritative store, cookie-cache bypass) and map a missing session to
  // 401 before reaching this boundary.
  readonly userId: string;
  // The request headers carrying the session, forwarded so the permission
  // endpoint evaluates the same session the caller resolved.
  readonly headers: Headers;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Resolves the authorized administrator or null when the session holder
// lacks User listing/read access. Unexpected engine or store defects throw
// to the caller's 500 boundary: they must never masquerade as denial.
export async function resolveAdminIdentity(
  input: AdminAuthorizationInput,
): Promise<AdminMe | null> {
  const outcome: unknown = await input.auth.api.userHasPermission({
    headers: input.headers,
    body: { userId: input.userId, permissions: { user: ['list'] } },
  });
  if (asRecord(outcome)?.success !== true) {
    return null;
  }
  const database = drizzle(input.db, { schema: identitySchema });
  const rows = await database
    .select({ id: user.id, email: user.email, emailVerified: user.emailVerified, role: user.role })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerified,
    // The plugin supplies the application default for rows predating the
    // role capability; storage nulls never reach the public contract.
    role: row.role ?? 'user',
  };
}
