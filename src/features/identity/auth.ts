import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { D1Database } from '@cloudflare/workers-types';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins/admin';
import { drizzle } from 'drizzle-orm/d1';
import {
  RESET_PASSWORD_ACTION_PATH,
  VERIFY_EMAIL_ACTION_PATH,
  buildAuthActionUrl,
} from './action-urls.js';
import type { AuthMailer } from './mailer.js';
import type { AuthPolicy } from './policy.js';
import { identitySchema } from './schema.js';

// Identity infrastructure boundary (ADR-0005, ADR-0010). This is the only
// module allowed to import Better Auth or the slice persistence schema:
// it translates the application-owned AuthPolicy/AuthMailer into Better Auth
// configuration and exposes a per-request auth instance. Handlers consume
// `auth.api` results through the public contracts, never persistence rows.
export interface IdentityAuthInput {
  readonly db: D1Database;
  readonly policy: AuthPolicy;
  readonly mailer: AuthMailer;
  readonly secret: string;
  readonly baseURL: string;
  // Canonical application-owned auth action pages (ticket #77). Optional
  // absolute HTTP(S) action-page URLs without a token; empty selects the
  // service-owned fallback browser routes on the request origin. Identity
  // appends exactly one `token` query parameter from the Better Auth token.
  // The engine callback URL never crosses the AuthMailer boundary.
  readonly verifyEmailActionURL?: string;
  readonly resetPasswordActionURL?: string;
  // Schedules provider-latency work outside the synchronous auth response
  // path (ADR-0010). Falls back to supervised fire-and-forget when the
  // request has no execution context (e.g. contract generation, unit calls).
  readonly background: (task: Promise<unknown>) => void;
}

// Better Auth internal log sink (ADR-0009): structured level + message only.
// Extra arguments can carry user objects or error instances, so they are
// never forwarded; messages themselves contain no passwords, tokens,
// cookies, action URLs or message bodies.
function createRedactingLogger(): NonNullable<Parameters<typeof betterAuth>[0]['logger']> {
  return {
    level: 'error',
    log: (level, message) => {
      console.log(JSON.stringify({ level, component: 'better-auth', message }));
    },
  };
}

// Builds a request-scoped Better Auth instance. Instances are cheap to
// construct (the underlying context initializes lazily) and must be scoped
// per request because the D1 binding, deployment policy, mailer and base URL
// all vary per request/environment. The return type is intentionally inferred
// so the precise engine options type flows to consumers instead of the
// generic default, which is not variance-compatible with it.
export function createIdentityAuth(input: IdentityAuthInput) {
  const {
    db,
    policy,
    mailer,
    secret,
    baseURL,
    verifyEmailActionURL,
    resetPasswordActionURL,
    background,
  } = input;
  const database = drizzle(db, { schema: identitySchema });

  return betterAuth({
    baseURL,
    secret,
    logger: createRedactingLogger(),
    database: drizzleAdapter(database, { provider: 'sqlite', schema: identitySchema }),
    // Better Auth supported administration capability (ticket #59, spec #8).
    // Roles, bans and session administration belong to the Identity boundary;
    // they are not editorial CMS roles and imply no custom admin UI. The
    // plugin's management endpoints are never mounted on the public Worker:
    // administration is exercised server-side through `auth.api` (notably the
    // explicit first-admin bootstrap), so enabling the plugin adds no public
    // HTTP surface by itself.
    plugins: [admin()],
    advanced: {
      backgroundTasks: {
        handler: (task) => {
          background(task);
        },
      },
    },
    emailAndPassword: {
      enabled: policy.emailPasswordEnabled,
      disableSignUp: !policy.registrationEnabled,
      requireEmailVerification: policy.requireEmailVerification,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      // Password recovery goes through the application-owned AuthMailer like
      // verification does; provider SDK/types stay inside adapters (ADR-0010).
      // Successful resets revoke existing sessions so previously issued
      // sessions cannot continue authenticating (ticket #12, ADR-0005).
      // The engine callback URL is an implementation detail (ticket #77): it
      // is never forwarded. Identity builds the user-facing reset action from
      // the configured consumer page (or the service-owned fallback route on
      // the request origin) plus the engine token.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        const url = buildAuthActionUrl({
          varName: 'AUTH_RESET_PASSWORD_ACTION_URL',
          configured: resetPasswordActionURL ?? '',
          requestOrigin: baseURL,
          fallbackPath: RESET_PASSWORD_ACTION_PATH,
          token,
        });
        await mailer.sendPasswordResetEmail({ to: user.email, url, token });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      // The engine verification callback URL never becomes public contract
      // (ticket #77): the user-facing action targets the configured consumer
      // page or the service-owned fallback route with the engine token as the
      // single `token` query parameter.
      sendVerificationEmail: async ({ user, token }) => {
        const url = buildAuthActionUrl({
          varName: 'AUTH_VERIFY_EMAIL_ACTION_URL',
          configured: verifyEmailActionURL ?? '',
          requestOrigin: baseURL,
          fallbackPath: VERIFY_EMAIL_ACTION_PATH,
          token,
        });
        await mailer.sendVerificationEmail({ to: user.email, url, token });
      },
    },
  });
}
