import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Env } from '../../env.js';
import { PROBLEM_JSON, createProblem, type ProblemCode } from '../../shared/problem.js';
import { createIdentityAuth } from './auth.js';
import { resolveAuthMailer, type AuthMailer } from './mailer.js';
import { resolveAuthPolicy, type AuthPolicy } from './policy.js';
import {
  currentUserRoute,
  loginRoute,
  registerRoute,
  requestPasswordResetRoute,
  requestVerificationRoute,
  resetPasswordRoute,
  signOutRoute,
  verifyEmailRoute,
} from './route.js';
import { resolveAuthSecret } from './secret.js';
import { resolveSessionContext, toAuthenticatedUser } from './session.js';

export interface IdentityRouterOptions {
  // Test seam: an explicitly provided mailer (in-memory in tests) takes
  // precedence over environment resolution.
  readonly authMailer?: AuthMailer;
}

type IdentityContext = Context<{ Bindings: Env }>;

// Better Auth failure surfaced either as an error Response (asResponse mode)
// or as a thrown APIError. Only the numeric status and string code cross
// this boundary; messages from the auth engine are never forwarded because
// they are not stable machine contracts.
interface EngineFailure {
  readonly status: number;
  readonly code?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function readEngineFailure(response: Response): Promise<EngineFailure> {
  let code: string | undefined;
  try {
    const payload: unknown = await response.json();
    const record = asRecord(payload);
    if (record !== null && typeof record.code === 'string') {
      code = record.code;
    }
  } catch {
    // Non-JSON failure bodies carry no machine contract; status is enough.
  }
  return { status: response.status, code };
}

function thrownEngineFailure(error: unknown): EngineFailure | null {
  const record = asRecord(error);
  const statusCode = record?.statusCode;
  if (typeof statusCode !== 'number') {
    return null;
  }
  const body = asRecord(record?.body);
  const code = body?.code;
  return { status: statusCode, code: typeof code === 'string' ? code : undefined };
}

// Calls a Better Auth server endpoint in asResponse mode so session cookies
// stay visible as Set-Cookie headers. Never throws for engine-level
// failures; only unexpected defects escape to the 500 boundary.
async function callEngine(call: () => Promise<Response>): Promise<Response | EngineFailure> {
  try {
    return await call();
  } catch (error) {
    return thrownEngineFailure(error) ?? { status: 500 };
  }
}

function backgroundScheduler(c: IdentityContext): (task: Promise<unknown>) => void {
  return (task) => {
    try {
      c.executionCtx.waitUntil(task);
      return;
    } catch {
      // No execution context (contract generation, bare unit calls): the
      // mailer transports used here complete their capture synchronously,
      // so this only supervises already-settled work.
    }
    task.catch(() => {
      console.log(JSON.stringify({ level: 'error', event: 'auth-mail.failed' }));
    });
  };
}

function scopedAuth(
  c: IdentityContext,
  override?: AuthMailer,
): { auth: ReturnType<typeof createIdentityAuth>; policy: AuthPolicy } {
  const policy = resolveAuthPolicy(c.env);
  const auth = createIdentityAuth({
    db: c.env.DB,
    policy,
    mailer: resolveAuthMailer(c.env, override),
    secret: resolveAuthSecret(c.env),
    baseURL: new URL(c.req.url).origin,
    background: backgroundScheduler(c),
  });
  return { auth, policy };
}

function problem(
  c: IdentityContext,
  status: 400 | 401 | 403 | 500,
  code: ProblemCode,
  title: string,
  detail?: string,
) {
  return c.json(
    createProblem({
      status,
      code,
      title,
      ...(detail === undefined ? {} : { detail }),
      instance: new URL(c.req.url).pathname,
    }),
    status,
    { 'Content-Type': PROBLEM_JSON },
  );
}

function forwardSessionCookies(c: IdentityContext, source: Response): void {
  const cookies =
    typeof source.headers.getSetCookie === 'function' ? source.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    c.header('Set-Cookie', cookie, { append: true });
  }
}

// Identity feature router (vertical slice, ADR-0002). Contract-bearing
// routes stay on the OpenAPI-aware router so their definitions survive
// mounting under `/v1`. Handlers map Better Auth outcomes onto the
// application-owned contracts; no Better Auth, session-token or D1 row type
// crosses the handler boundary.
export function createIdentityRouter(options: IdentityRouterOptions = {}) {
  const router = new OpenAPIHono<{ Bindings: Env }>();
  const override = options.authMailer;

  router.openapi(registerRoute, async (c) => {
    const { auth, policy } = scopedAuth(c, override);
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }
    if (!policy.registrationEnabled) {
      return problem(c, 403, 'registration-disabled', 'Registration is disabled');
    }

    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.password },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        const user = toAuthenticatedUser(await outcome.json().catch(() => null));
        if (user === null) {
          return problem(c, 500, 'internal-error', 'Internal Server Error');
        }
        return c.json(user, 201);
      }
      return problem(c, 400, 'bad-request', 'Bad Request');
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(loginRoute, async (c) => {
    const { auth, policy } = scopedAuth(c, override);
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.signInEmail({
        body: { email: input.email, password: input.password },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        const user = toAuthenticatedUser(await outcome.json().catch(() => null));
        if (user === null) {
          return problem(c, 500, 'internal-error', 'Internal Server Error');
        }
        forwardSessionCookies(c, outcome);
        return c.json(user, 200);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status === 403 && failure.code === 'EMAIL_NOT_VERIFIED') {
        return problem(
          c,
          403,
          'email-verification-required',
          'Email verification required',
          'Verify the email address before signing in.',
        );
      }
      if (failure.status === 401) {
        return problem(c, 401, 'invalid-credentials', 'Invalid credentials');
      }
      return problem(c, 400, 'bad-request', 'Bad Request');
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(verifyEmailRoute, async (c) => {
    const { auth } = scopedAuth(c, override);
    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.verifyEmail({
        query: { token: input.token },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        // The engine returns `{ status: true, user: null }` on this path;
        // the verified address is the one the client submitted the action
        // for, and eligibility is proven by the subsequent login instead of
        // by echoing engine internals.
        return c.json({ emailVerified: true as const }, 200);
      }
      return problem(
        c,
        400,
        'verification-invalid',
        'Invalid or expired verification',
        'The verification action is invalid or has expired.',
      );
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(requestVerificationRoute, async (c) => {
    const { auth, policy } = scopedAuth(c, override);
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.sendVerificationEmail({
        body: { email: input.email },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        // Generic acceptance: the engine answers identically for unknown,
        // verified and unverified addresses, so this response cannot be
        // used for account enumeration and never creates identities.
        return c.json({ status: 'ok' as const }, 202);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.code === 'EMAIL_MISMATCH') {
        return problem(c, 400, 'bad-request', 'Bad Request');
      }
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error');
      }
      return c.json({ status: 'ok' as const }, 202);
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(requestPasswordResetRoute, async (c) => {
    const { auth, policy } = scopedAuth(c, override);
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.requestPasswordReset({
        body: { email: input.email },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        // Generic acceptance: the engine answers identically for unknown and
        // known addresses, so this response cannot be used for account
        // enumeration and never creates identities.
        return c.json({ status: 'ok' as const }, 202);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error');
      }
      return c.json({ status: 'ok' as const }, 202);
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(resetPasswordRoute, async (c) => {
    const { auth, policy } = scopedAuth(c, override);
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.resetPassword({
        body: { newPassword: input.newPassword, token: input.token },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        // The engine consumes the reset action (single use) and revokes
        // existing sessions per the accepted security default.
        return c.json({ status: 'ok' as const }, 200);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error');
      }
      return problem(
        c,
        400,
        'reset-invalid',
        'Invalid or expired password reset',
        'The password-reset action is invalid or has expired.',
      );
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(currentUserRoute, async (c) => {
    const session = await resolveSessionContext({
      env: c.env,
      headers: c.req.raw.headers,
      baseURL: new URL(c.req.url).origin,
      authMailer: override,
      background: backgroundScheduler(c),
    });
    if (session === null) {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    return c.json(session.user, 200);
  });

  router.openapi(signOutRoute, async (c) => {
    const { auth } = scopedAuth(c, override);
    const outcome = await callEngine(() =>
      auth.api.signOut({
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      // Forward the clearing cookie so the browser/API client drops the
      // session. Sign-out stays idempotent: 4xx engine answers still end as
      // `ok` so the response cannot be used to probe session state.
      forwardSessionCookies(c, outcome);
      if (outcome.ok) {
        return c.json({ status: 'ok' as const }, 200);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error');
      }
      return c.json({ status: 'ok' as const }, 200);
    }
    const failure = outcome;
    if (failure.status >= 500) {
      return problem(c, 500, 'internal-error', 'Internal Server Error');
    }
    return c.json({ status: 'ok' as const }, 200);
  });

  return router;
}
