import { defineConfig } from 'drizzle-kit';

// D1 migration source for the identity slice (ADR-0004, ticket #10).
// `npx drizzle-kit generate` renders versioned SQL under `./drizzle` from the
// slice-owned schema; `wrangler d1 migrations apply` consumes the same files
// for local/staging/production, and Workers-runtime tests apply them to the
// isolated test database.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/features/identity/schema.ts',
  out: './drizzle',
});
