import { createIdentityRouter, type IdentityRouterOptions } from './router.js';

// Public slice interface for the identity feature (AGENTS.md change rules).
// Cross-feature consumers (including the application composition root) may
// import only this module, the application-owned contracts, policy and mail
// boundary. `auth.ts` (Better Auth wiring) and `schema.ts` (D1 rows) are
// slice internals and must never be imported outside this directory.
export { createIdentityRouter };
export type { IdentityRouterOptions };
export type {
  LoginRequest,
  LoginResult,
  RegisterRequest,
  RegisteredUser,
  VerifyEmailRequest,
  VerifyEmailResult,
} from './contract.js';
export type { AuthMailer, VerificationMessage } from './mailer.js';
export { InMemoryAuthMailer } from './mailer.js';
export type { AuthPolicy } from './policy.js';
export { DEFAULT_AUTH_POLICY, resolveAuthPolicy } from './policy.js';
