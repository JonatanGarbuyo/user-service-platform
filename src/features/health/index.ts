import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env } from '../../env.js';
import type { HealthResponse } from './contract.js';
import { healthRoute } from './route.js';

// Health feature router (vertical slice, ADR-0002). Contract-bearing routers stay
// on the OpenAPI-aware router so their definitions survive mounting.
export function createHealthRouter() {
  const router = new OpenAPIHono<{ Bindings: Env }>();

  router.openapi(healthRoute, (c) => {
    const payload: HealthResponse = {
      status: 'ok',
      service: 'user-service',
      version: 'v1',
      now: new Date().toISOString(),
    };
    return c.json(payload, 200);
  });

  return router;
}
