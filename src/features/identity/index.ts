import { createIdentityRouter, type IdentityRouterOptions } from './router.js';

// Public slice interface for the identity feature (AGENTS.md change rules).
// Cross-feature consumers (including the application composition root) may
// import only this module, the application-owned contracts, policy and mail
// boundary. `auth.ts` (Better Auth wiring) and `schema.ts` (D1 rows) are
// slice internals and must never be imported outside this directory.
export { createIdentityRouter };
export type { IdentityRouterOptions };
export type {
  CurrentUser,
  LoginRequest,
  LoginResult,
  RegisterRequest,
  RegisteredUser,
  RequestPasswordResetRequest,
  RequestPasswordResetResult,
  ResetPasswordRequest,
  ResetPasswordResult,
  SignOutResult,
  VerifyEmailRequest,
  VerifyEmailResult,
} from './contract.js';
export type { AuthMailer, PasswordResetMessage, VerificationMessage } from './mailer.js';
export { InMemoryAuthMailer, ResendAuthMailer } from './mailer.js';
export type { AuthMailPurpose, ResendTransportConfig } from './mailer.js';
export type { AuthMailLogger, AuthMailLogRecord } from './mailer.js';
export type { AuthPolicy } from './policy.js';
export { DEFAULT_AUTH_POLICY, resolveAuthPolicy } from './policy.js';
export type { AuthenticatedUser, ResolveSessionInput, SessionContext } from './session.js';
export { resolveSessionContext, toAuthenticatedUser, toSessionContext } from './session.js';
