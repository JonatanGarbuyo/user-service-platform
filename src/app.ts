import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { requestId } from 'hono/request-id';
import type { Env } from './env.js';
import { createHealthRouter } from './features/health/index.js';
import {
  createAuthActionsRouter,
  createIdentityRouter,
  type IdentityRouterOptions,
} from './features/identity/index.js';
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
// Serves one administration SPA path through the Static Assets binding
// (ticket #124). Exact asset hits stream through untouched; misses under
// `/admin` fall back to the SPA entry. Without a bound asset pipeline
// (notably unit-test boots and checkouts without a prior `build:admin`)
// the request ends as JSON Problem Details instead of crashing; the deploy
// preflight fails closed when distributable assets are missing.
async function serveAdminAsset(c: Context<AppBindings>, path: string): Promise<Response> {
  const assets = (c.env as Partial<Env> | undefined)?.ASSETS;
  if (assets === undefined) {
    return c.json(
      createProblem({
        status: 404,
        code: 'not-found',
        title: 'Not Found',
        instance: new URL(c.req.url).pathname,
      }),
      404,
      { 'Content-Type': PROBLEM_JSON },
    );
  }
  const origin = new URL(c.req.url).origin;
  // Vite's dist contains index.html and assets/ at its root. Public URLs
  // retain /admin; only the binding request removes that mount prefix.
  const assetPath =
    path === '/admin' || path === '/admin/' ? '/index.html' : path.slice('/admin'.length);
  const hit = await assets.fetch(new Request(`${origin}${assetPath}`, c.req.raw));
  if (hit.status !== 404) {
    return hit;
  }
  // Single-page-application fallback, scoped to `/admin` only: client routes
  // (including the sign-in deep link) boot from the same entry document.
  // Missing hashed assets must stay 404; returning HTML would disguise an
  // invalid deployment as a JavaScript parse failure.
  if (assetPath.startsWith('/assets/')) return hit;
  const entry = await assets.fetch(new Request(`${origin}/index.html`, c.req.raw));
  // A conditional navigation can revalidate the cached SPA entry. Preserve
  // its 304 so the browser reuses HTML rather than replacing it with JSON 404.
  if (entry.ok || entry.status === 304) {
    return entry;
  }
  return c.json(
    createProblem({
      status: 404,
      code: 'not-found',
      title: 'Not Found',
      instance: new URL(c.req.url).pathname,
    }),
    404,
    { 'Content-Type': PROBLEM_JSON },
  );
}

export function createApp(identityOptions: IdentityRouterOptions = {}) {
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
  app.route('/v1', createIdentityRouter(identityOptions));
  // Service-owned fallback browser action pages (ticket #77). Plain HTML
  // handlers outside the versioned JSON API: they complete through the
  // existing POST `/v1` contracts and never enter the OpenAPI document.
  app.route('/auth-actions', createAuthActionsRouter());
  // Administration SPA (ticket #124, ADR-0012). The built client-only assets
  // are served on this same origin under `/admin` through the Static Assets
  // binding, so browser navigation keeps the HttpOnly session cookie.
  // Precedence is explicit: `/v1/*` and `/auth-actions/*` above keep their
  // behavior, asset misses under `/admin` fall back to the SPA entry so the
  // sign-in deep link survives refresh, and the fallback never applies
  // outside `/admin` (unknown `/v1` routes stay JSON Problem Details).
  app.get('/admin', (c) => serveAdminAsset(c, '/admin/index.html'));
  app.get('/admin/*', (c) => serveAdminAsset(c, new URL(c.req.url).pathname));

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
