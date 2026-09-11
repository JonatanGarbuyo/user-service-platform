import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Workers-runtime test project (ADR-0011): feature/module tests execute inside the
// Cloudflare Workers runtime with isolated local storage via Miniflare. Only tests
// that run under the Workers runtime live in `src/**`; Node-only tests (generated
// artifact determinism, whole-Worker harness) run under vitest.harness.config.ts.
//
// D1 migrations are read in Node at config time from the same versioned `./drizzle`
// directory consumed by `wrangler d1 migrations apply`, then exposed to the worker
// isolate as a test-only binding so suites can apply them to the isolated test
// database without duplicating SQL (ticket #10).
const root = dirname(fileURLToPath(import.meta.url));
const d1Migrations = await readD1Migrations(join(root, 'drizzle'));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: d1Migrations },
      },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
