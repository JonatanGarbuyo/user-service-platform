import type { D1Database } from '@cloudflare/workers-types';

// Worker environment bindings (ticket #9 seam). D1 is declared so isolated local
// tests resolve the binding through Wrangler/Miniflare configuration; no business
// persistence abstractions live here. Drizzle schema and migrations arrive with
// the identity slice.
export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
}
