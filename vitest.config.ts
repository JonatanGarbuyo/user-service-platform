import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Workers-runtime test project (ADR-0011): feature/module tests execute inside the
// Cloudflare Workers runtime with isolated local storage via Miniflare. Only tests
// that run under the Workers runtime live in `src/**`; Node-only tests (generated
// artifact determinism, whole-Worker harness) run under vitest.harness.config.ts.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
