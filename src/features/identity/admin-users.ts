import type { D1Database } from '@cloudflare/workers-types';
import { asc, count, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { AdminUser, AdminUserList } from './contract.js';
import { identitySchema, user } from './schema.js';

// Application-owned protected User listing (ticket #125, spec #123). This
// module owns the read query inside Identity's infrastructure boundary: it
// projects only the explicitly selected administrative fields in ascending
// email order, so credentials, session tokens and raw persistence rows never
// reach callers. Authorization is decided by the caller through
// `resolveAdminIdentity` before this read; this module performs no
// permission check itself.
export interface ListAdminUsersInput {
  // Slice-owned D1 binding, used read-only for the listing and its total.
  readonly db: D1Database;
  // Validated bounds from the public contract: limit 1..100, offset >= 0.
  readonly limit: number;
  readonly offset: number;
  // Optional validated literal email substring (trimmed, nonempty, <= 254).
  // Undefined lists every User.
  readonly email?: string;
}

// Escapes the three LIKE metacharacters so the search term stays a literal
// substring: backslash (the escape character itself), percent and underscore.
// The escaped term is matched case-insensitively through `lower(email)`;
// the pattern parameter stays bound, never interpolated into SQL text.
function escapeLikeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function toAdminUser(row: {
  id: string;
  email: string;
  emailVerified: boolean;
  role: string | null;
}): AdminUser {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerified,
    // The plugin supplies the application default for rows predating the
    // role capability; storage nulls never reach the public contract.
    role: row.role ?? 'user',
  };
}

export interface GetAdminUserInput {
  // Slice-owned D1 binding, used read-only for the single-row lookup.
  readonly db: D1Database;
  // Validated opaque identifier from the public contract (nonempty, <= 128).
  readonly userId: string;
}

// Reads one administrative User through the exact safe projection. Returns
// null when no row matches the opaque identifier. Like the listing, this
// read performs no permission check itself: callers resolve the
// administrator through `resolveAdminIdentity` before this lookup, so
// anonymous and non-administrative callers never reach it. Identifiers and
// result contents are never logged here.
export async function getAdminUserById(input: GetAdminUserInput): Promise<AdminUser | null> {
  const database = drizzle(input.db, { schema: identitySchema });
  const rows = await database
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      role: user.role,
    })
    .from(user)
    .where(eq(user.id, input.userId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return toAdminUser(row);
}
// Lists administrative Users with deterministic ascending-email pagination.
// `total` counts every literal match before limit/offset apply, so clients
// can page without re-reading. Search terms, addresses and result contents
// are never logged here; callers keep request logs to safe metadata only.
export async function listAdminUsers(input: ListAdminUsersInput): Promise<AdminUserList> {
  const database = drizzle(input.db, { schema: identitySchema });
  const selection = {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
  };

  if (input.email === undefined) {
    const [rows, totals] = await Promise.all([
      database
        .select(selection)
        .from(user)
        .orderBy(asc(user.email))
        .limit(input.limit)
        .offset(input.offset),
      database.select({ total: count() }).from(user),
    ]);
    return { items: rows.map(toAdminUser), total: totals[0]?.total ?? 0 };
  }

  const pattern = `%${escapeLikeLiteral(input.email.toLowerCase())}%`;
  const matches = sql`lower(${user.email}) LIKE ${pattern} ESCAPE '\\'`;
  const [rows, totals] = await Promise.all([
    database
      .select(selection)
      .from(user)
      .where(matches)
      .orderBy(asc(user.email))
      .limit(input.limit)
      .offset(input.offset),
    database.select({ total: count() }).from(user).where(matches),
  ]);
  return { items: rows.map(toAdminUser), total: totals[0]?.total ?? 0 };
}
