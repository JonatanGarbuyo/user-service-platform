import { z } from '@hono/zod-openapi';

// Application-owned identity contracts (ADR-0002, ADR-0007). These schemas
// are the single source for runtime validation, TypeScript inference and the
// generated OpenAPI document. They never expose Better Auth models, session
// tokens, password material or D1 row representations (ticket #10).
const emailField = z
  .email({ error: 'Expected an email address.' })
  .max(254)
  .openapi({ example: 'ada@example.com' });

const passwordField = z
  .string()
  .min(8, { error: 'Password must be at least 8 characters.' })
  .max(128, { error: 'Password must be at most 128 characters.' })
  .openapi({ example: 'correct-horse-41' });

export const RegisterRequestSchema = z
  .object({
    name: z.string().min(1).max(200).openapi({ example: 'Ada Lovelace' }),
    email: emailField,
    password: passwordField,
  })
  .openapi('RegisterRequest');

export const RegisteredUserSchema = z
  .object({
    id: z.string().openapi({ example: 'abc123' }),
    email: emailField,
    emailVerified: z.boolean().openapi({ example: false }),
  })
  .openapi('RegisteredUser');

export const LoginRequestSchema = z
  .object({
    email: emailField,
    password: z.string().min(1).max(128).openapi({ example: 'correct-horse-41' }),
  })
  .openapi('LoginRequest');

export const LoginResultSchema = z
  .object({
    id: z.string().openapi({ example: 'abc123' }),
    email: emailField,
    emailVerified: z.boolean().openapi({ example: true }),
  })
  .openapi('LoginResult');

export const VerifyEmailRequestSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .openapi({ description: 'Verification token from the action URL.' }),
  })
  .openapi('VerifyEmailRequest');

export const VerifyEmailResultSchema = z
  .object({
    // The engine confirms verification with `{ status: true }` and no user
    // payload on this path, so the result carries only the externally
    // observable outcome. Changed login eligibility (proven by a subsequent
    // login) is the identity signal, not an engine echo.
    emailVerified: z.literal(true).openapi({ example: true }),
  })
  .openapi('VerifyEmailResult');

export const RequestVerificationRequestSchema = z
  .object({
    email: emailField,
  })
  .openapi('RequestVerificationRequest');

export const RequestVerificationResultSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
  })
  .openapi('RequestVerificationResult');

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RegisteredUser = z.infer<typeof RegisteredUserSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResult = z.infer<typeof LoginResultSchema>;
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;
export type VerifyEmailResult = z.infer<typeof VerifyEmailResultSchema>;
