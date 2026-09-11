// Type-only surface for the Workers Vitest integration (`cloudflare:test`)
// so the Node-side typecheck covers worker tests. At runtime the pool
// provides the real module; this declaration only fills the compile-time
// gap and must stay minimal. Kept import-free so the file is a global
// script and the ambient module declaration always applies.
declare module 'cloudflare:test' {
  import type { D1Database } from '@cloudflare/workers-types';

  export interface D1Migration {
    readonly name: string;
    readonly queries: readonly string[];
  }

  export const env: {
    readonly DB: D1Database;
  } & Record<string, unknown>;

  export function applyD1Migrations(
    db: D1Database,
    migrations: readonly D1Migration[],
    migrationsTableName?: string,
  ): Promise<void>;
}
