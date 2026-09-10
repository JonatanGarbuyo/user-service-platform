import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

// Seam under test: unhandled public API paths through the built Worker. Ticket #9
// requires the RFC 9457-compatible Problem Details shape for invalid/unhandled
// failures; this pins the envelope, the stable machine code and the media type.
describe('unhandled routes', () => {
  it('returns RFC 9457 problem details for unknown operations', async () => {
    const app = createApp();
    const res = await app.request('/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const body = await res.json();
    expect(body).toEqual({
      type: 'urn:problem:not-found',
      title: 'Not Found',
      status: 404,
      code: 'not-found',
      instance: '/v1/does-not-exist',
    });
  });
});
