import { z } from '@hono/zod-openapi';

// Application-owned liveness contract for the health feature slice (ADR-0002,
// ADR-0007). This schema is the single source for runtime validation, TypeScript
// inference and the generated OpenAPI document: it is never hand-duplicated.
export const HealthResponseSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
    service: z.string().openapi({ example: 'user-service' }),
    version: z.string().openapi({ example: 'v1' }),
    now: z.string().openapi({ format: 'date-time', example: '2026-09-10T00:00:00.000Z' }),
  })
  .openapi('HealthResponse');

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
