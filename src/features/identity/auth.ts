import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { D1Database } from '@cloudflare/workers-types';
import { betterAuth } from 'better-auth';
import { drizzle } from 'drizzle-orm/d1';
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
  const { db, policy, mailer, secret, baseURL, background } = input;
  const database = drizzle(db, { schema: identitySchema });

  return betterAuth({
    baseURL,
    secret,
    logger: createRedactingLogger(),
    database: drizzleAdapter(database, { provider: 'sqlite', schema: identitySchema }),
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
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) => {
        await mailer.sendPasswordResetEmail({ to: user.email, url, token });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url, token }) => {
        await mailer.sendVerificationEmail({ to: user.email, url, token });
      },
    },
  });
}
