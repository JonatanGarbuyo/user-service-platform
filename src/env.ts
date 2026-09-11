import type { D1Database } from '@cloudflare/workers-types';

// Worker environment bindings (ticket #9 seam). D1 is declared so isolated local
// tests resolve the binding through Wrangler/Miniflare configuration; no business
// persistence abstractions live here. The identity slice owns its Drizzle schema
// and migrations (ticket #10).
export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  // Application-owned authentication policy inputs (ADR-0005). Plain vars
  // (not secrets) using "true"/"false" strings; absent values fall back to
  // the deployment defaults resolved by the identity slice.
  AUTH_REGISTRATION_ENABLED?: string;
  AUTH_EMAIL_PASSWORD_ENABLED?: string;
  AUTH_REQUIRE_EMAIL_VERIFICATION?: string;
  // Better Auth signing secret. Required in staging/production; local/test
  // environments fall back to an explicit dev-only value (never a production
  // credential) so tests need no secrets.
  BETTER_AUTH_SECRET?: string;
  // Mail transport selection (ADR-0010): "inmemory" for tests, unset for the
  // local development sink. Staging/production fail closed without the real
  // transport delivered in ticket #13.
  AUTH_MAIL_TRANSPORT?: string;
}
