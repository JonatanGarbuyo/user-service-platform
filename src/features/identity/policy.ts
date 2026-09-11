import type { Env } from '../../env.js';

// Application-owned authentication policy (ADR-0005). Deployment-level
// configuration that controls supported authentication behaviour without
// exposing Better Auth configuration to feature code. The identity
// infrastructure layer translates this policy into Better Auth options per
// request; business feature slices never see either representation.
export interface AuthPolicy {
  // Whether public email/password registration accepts new accounts.
  readonly registrationEnabled: boolean;
  // Whether email/password authentication is available at all.
  readonly emailPasswordEnabled: boolean;
  // Whether an email/password session requires a verified email address.
  // The initial deployment requires verification (CONTEXT.md).
  readonly requireEmailVerification: boolean;
}

// Deployment defaults for the initial single-client release: open
// registration with email/password, gated on verified email.
export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  registrationEnabled: true,
  emailPasswordEnabled: true,
  requireEmailVerification: true,
};

function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return value.toLowerCase() === 'true';
}

// Resolves the effective policy from Worker environment vars. Unknown or
// absent values fall back to the deployment defaults; only the explicit
// string "true" (case-insensitive) enables a capability.
export function resolveAuthPolicy(
  env: Pick<
    Env,
    'AUTH_REGISTRATION_ENABLED' | 'AUTH_EMAIL_PASSWORD_ENABLED' | 'AUTH_REQUIRE_EMAIL_VERIFICATION'
  >,
): AuthPolicy {
  return {
    registrationEnabled: parseFlag(
      env.AUTH_REGISTRATION_ENABLED,
      DEFAULT_AUTH_POLICY.registrationEnabled,
    ),
    emailPasswordEnabled: parseFlag(
      env.AUTH_EMAIL_PASSWORD_ENABLED,
      DEFAULT_AUTH_POLICY.emailPasswordEnabled,
    ),
    requireEmailVerification: parseFlag(
      env.AUTH_REQUIRE_EMAIL_VERIFICATION,
      DEFAULT_AUTH_POLICY.requireEmailVerification,
    ),
  };
}
