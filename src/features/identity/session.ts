import type { Env } from '../../env.js';
import { createIdentityAuth } from './auth.js';
import { resolveAuthMailer, type AuthMailer } from './mailer.js';
import { resolveAuthPolicy } from './policy.js';
import { resolveAuthSecret } from './secret.js';

// Stable application-owned authenticated identity (ADR-0005, CONTEXT.md).
// Feature slices consume this contract instead of Better Auth persistence
// models, provider-specific types, session tokens or D1 row representations.
// It mirrors the public `/v1/me` representation: only the stable identity
// fields cross the boundary.
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

// Stable application-facing session data available to authenticated feature
// slices. It carries the resolved user; session mechanics (tokens, cookies,
// storage rows) stay inside the identity slice.
export interface SessionContext {
  readonly user: AuthenticatedUser;
}

export interface ResolveSessionInput {
  readonly env: Env;
  readonly headers: Headers;
  readonly baseURL: string;
  readonly authMailer?: AuthMailer;
  // Request execution-context scheduler for provider-latency work. Callers
  // with an execution context (request handlers) pass it through so session
  // resolution shares the slice's background semantics; callers without one
  // fall back to supervised fire-and-forget. Session reads never trigger
  // mail, so this only preserves consistent wiring.
  readonly background?: (task: Promise<unknown>) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Pure boundary mapper: engine session payloads become application-owned
// users. Returns null when the payload does not carry the stable shape so
// callers treat unknown shapes as unauthenticated rather than crash.
export function toAuthenticatedUser(payload: unknown): AuthenticatedUser | null {
  const user = asRecord(asRecord(payload)?.user);
  if (
    user === null ||
    typeof user.id !== 'string' ||
    typeof user.email !== 'string' ||
    typeof user.emailVerified !== 'boolean'
  ) {
    return null;
  }
  return { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

export function toSessionContext(payload: unknown): SessionContext | null {
  const user = toAuthenticatedUser(payload);
  if (user === null) {
    return null;
  }
  return { user };
}

// Request-scoped session resolver for future feature slices (ticket #11).
// Callers pass Worker env, request headers and request origin; this module
// owns the Better Auth wiring internally so no Better Auth type crosses the
// public slice boundary. Returns null when no valid session resolves;
// unexpected infrastructure defects throw to the caller's 500 boundary.
export async function resolveSessionContext(
  input: ResolveSessionInput,
): Promise<SessionContext | null> {
  const policy = resolveAuthPolicy(input.env);
  const background =
    input.background ??
    ((task) => {
      task.catch(() => {
        console.log(JSON.stringify({ level: 'error', event: 'auth-mail.failed' }));
      });
    });
  const auth = createIdentityAuth({
    db: input.env.DB,
    policy,
    mailer: resolveAuthMailer(input.env, input.authMailer),
    secret: resolveAuthSecret(input.env),
    baseURL: input.baseURL,
    background,
  });

  // Bypass the signed cookie cache so a revoked session cannot authorize
  // through cached payload after sign-out; the D1 store is authoritative.
  const session = await auth.api.getSession({
    headers: input.headers,
    query: { disableCookieCache: true },
  });
  if (session === null) {
    return null;
  }
  return toSessionContext(session);
}
