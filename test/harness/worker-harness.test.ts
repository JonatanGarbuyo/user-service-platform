import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerHarness } from './worker-harness.js';
import type { TestHarness } from 'wrangler';

// Proves the whole-Worker seam is available: the built Worker boots under the
// Wrangler test harness and serves the versioned health operation end to end.
describe('whole-Worker harness', () => {
  let server: TestHarness;

  beforeAll(async () => {
    server = createWorkerHarness();
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves the health operation through the built Worker', async () => {
    const res = await server.fetch('/v1/health');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });
});
