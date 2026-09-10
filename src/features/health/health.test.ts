import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { HealthResponseSchema } from './contract.js';

// Seam under test: the public HTTP boundary of the built Worker, executed inside
// the Cloudflare Workers runtime. The test asserts the externally observable
// liveness contract from ticket #9, not router internals.
describe('GET /v1/health', () => {
  it('serves the stable liveness contract', async () => {
    const app = createApp();
    const res = await app.request('/v1/health');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = HealthResponseSchema.parse(await res.json());
    expect(body.status).toBe('ok');
    expect(body.service).toBe('user-service');
    expect(body.version).toBe('v1');
    expect(typeof body.now).toBe('string');
  });

  it('answers without requiring environment bindings', async () => {
    const app = createApp();
    const res = await app.request('/v1/health');

    expect(res.status).toBe(200);
  });
});
