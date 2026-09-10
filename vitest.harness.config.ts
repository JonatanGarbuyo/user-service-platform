import { defineConfig } from 'vitest/config';

// Node-runtime test project: tests that cannot execute inside workerd — generated
// OpenAPI artifact determinism (node:fs) and the whole-Worker Wrangler test harness
// (spawns its own workerd server) — run here in the standard Node environment.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
