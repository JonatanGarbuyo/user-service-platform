import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { requestId } from 'hono/request-id';
import type { Env } from './env.js';
import { createHealthRouter } from './features/health/index.js';
import { openApiConfig } from './openapi.js';
import { PROBLEM_JSON, createProblem } from './shared/problem.js';

interface AppVariables {
  requestId: string;
}

export interface AppBindings {
  Bindings: Env;
  Variables: AppVariables;
}

// Reads the deployment environment without assuming bindings are present.
// Hono types `c.env` as always defined, but requests driven via
// `app.request()` without an explicit Env leave it undefined at runtime;
// liveness and error paths must never crash on that.
function readEnvironment(c: Context<AppBindings>): string {
  const bindings = c.env as Partial<Env> | undefined;
  return bindings?.ENVIRONMENT ?? 'local';
}

// Application composition root. Feature slices register their OpenAPI-aware
// routers here under the `/v1` namespace; cross-feature imports must stay on
// public slice interfaces (AGENTS.md change rules).
export function createApp() {
  const app = new OpenAPIHono<AppBindings>({
    // Contract-wide validation failure shape: invalid public API input uses the
    // RFC 9457 Problem Details envelope instead of the framework default.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          createProblem({
            status: 400,
            code: 'bad-request',
            title: 'Bad Request',
            detail: 'The request did not match the public contract.',
            instance: new URL(c.req.url).pathname,
          }),
          400,
          { 'Content-Type': PROBLEM_JSON },
        );
      }
      return undefined;
    },
  });

  app.use(requestId());

  // Structured request log (ADR-0009): correlation id, request path, status and
  // duration. Credentials, tokens and personal data are never logged. The current
  // public surface has no parameterized paths; when feature slices introduce
  // `:param` segments, this middleware must log the matched route pattern
  // instead of raw paths that could carry sensitive values.
  app.use(async (c, next) => {
    const started = Date.now();
    await next();
    const record = {
      level: c.error === undefined ? 'info' : 'error',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - started,
      environment: readEnvironment(c),
    };
    console.log(JSON.stringify(record));
  });

  app.route('/v1', createHealthRouter());

  app.doc('/v1/openapi.json', openApiConfig);

  app.notFound((c) =>
    c.json(
      createProblem({
        status: 404,
        code: 'not-found',
        title: 'Not Found',
        instance: new URL(c.req.url).pathname,
      }),
      404,
      { 'Content-Type': PROBLEM_JSON },
    ),
  );

  // Exception messages are never logged: future auth/DB/provider errors can
  // carry secrets, so the log carries only stable identifiers and safe
  // metadata (ADR-0009, PR #15 acceptance review).
  app.onError((_err, c) => {
    console.log(
      JSON.stringify({
        level: 'error',
        requestId: c.get('requestId'),
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: 500,
        code: 'internal-error',
        environment: readEnvironment(c),
      }),
    );
    return c.json(
      createProblem({
        status: 500,
        code: 'internal-error',
        title: 'Internal Server Error',
      }),
      500,
      { 'Content-Type': PROBLEM_JSON },
    );
  });

  return app;
}
