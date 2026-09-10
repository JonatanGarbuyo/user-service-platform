import { createTestHarness, type TestHarness } from 'wrangler';

// Whole-Worker integration seam (ADR-0011, ticket #9). Later identity flows reuse
// this helper to exercise production-shaped Worker configuration and routing —
// register -> verify -> sign in -> GET /v1/me — with D1 migrations applied to the
// isolated test state. Ticket #9 proves the seam with the health operation only.
export function createWorkerHarness(): TestHarness {
  return createTestHarness({
    workers: [{ configPath: './wrangler.jsonc' }],
  });
}
