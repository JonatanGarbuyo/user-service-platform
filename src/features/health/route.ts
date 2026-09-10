import { createRoute } from '@hono/zod-openapi';
import { HealthResponseSchema } from './contract.js';

// Public operation definition for the liveness probe. The feature owns the
// `/health` path; the `/v1` namespace is applied when the application mounts
// the feature router (ADR-0007).
export const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  operationId: 'getHealth',
  summary: 'Service liveness',
  description:
    'Lightweight liveness probe. It proves the Worker and router are running ' +
    'without touching D1 or any other dependency.',
  tags: ['health'],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: HealthResponseSchema,
        },
      },
      description: 'The Worker is running.',
    },
  },
});
