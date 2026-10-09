import { defineConfig } from 'vitest/config';

// Node-runtime test project: tests that cannot execute inside workerd — generated
// OpenAPI artifact determinism (node:fs) and the whole-Worker Wrangler test harness
// (spawns its own workerd server) — run here in the standard Node environment.
//
// Ticket #124: `globalSetup` rebuilds the administration SPA before the run so
// the Wrangler-based harness always boots against the current versioned
// frontend sources and the production build stays gated here.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    globalSetup: ['test/harness/global-setup.ts'],
  },
});
