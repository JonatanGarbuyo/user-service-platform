// Versioned non-secret environment profiles (spec #8, ticket #57).
//
// Each operational environment owns one complete profile using the exact
// canonical runtime variable names, so runtime overrides apply by the same
// key without a translation vocabulary. Profiles are independent literals:
// they never spread from a shared base, and they are frozen so runtime code
// cannot mutate versioned defaults.
//
// Secrets are structurally excluded: the profile type only admits
// `NonSecretVarName` keys, so placing `BETTER_AUTH_SECRET`, `RESEND_API_KEY`
// or SMTP credentials through this path is a type error, not a review
// observation. Sandbox/production secrets are configured directly in
// Cloudflare and never appear here.
export const NON_SECRET_VAR_NAMES = [
  'ENVIRONMENT',
  'AUTH_REGISTRATION_ENABLED',
  'AUTH_EMAIL_PASSWORD_ENABLED',
  'AUTH_REQUIRE_EMAIL_VERIFICATION',
  'AUTH_MAIL_TRANSPORT',
  'AUTH_MAIL_FROM',
  'AUTH_APP_NAME',
  'AUTH_MAIL_ALLOWLIST',
  'AUTH_VERIFY_EMAIL_ACTION_URL',
  'AUTH_RESET_PASSWORD_ACTION_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
] as const;

export type NonSecretVarName = (typeof NON_SECRET_VAR_NAMES)[number];

// Complete non-secret configuration for one environment. Every key is a
// required string: an empty string marks an explicitly unset slot (same
// semantics as an absent runtime variable), never a missing key.
export type NonSecretProfile = Record<NonSecretVarName, string>;

// Canonical operational environments (ADR-0008). There is no `staging`
// profile: historical staging references mean `sandbox`.
export type CanonicalEnvironment = 'local' | 'sandbox' | 'production';

// Known secret inputs. They must never enter versioned profiles or merged
// non-secret configuration; they travel as runtime secrets only.
export const SECRET_VAR_NAMES = [
  'BETTER_AUTH_SECRET',
  'RESEND_API_KEY',
  'SMTP_USER',
  'SMTP_PASSWORD',
] as const;

export type SecretVarName = (typeof SECRET_VAR_NAMES)[number];

function freezeProfile(profile: NonSecretProfile): NonSecretProfile {
  return Object.freeze({ ...profile });
}

// Local development defaults: open registration gated on verified email with
// the metadata-only development mail sink (unset transport). SMTP slots stay
// explicitly unset until a real-delivery local scenario selects the SMTP
// transport (ticket #58). Auth action URL slots stay explicitly unset so local
// mail targets the service-owned fallback action pages (ticket #77).
export const LOCAL_PROFILE: NonSecretProfile = freezeProfile({
  ENVIRONMENT: 'local',
  AUTH_REGISTRATION_ENABLED: 'true',
  AUTH_EMAIL_PASSWORD_ENABLED: 'true',
  AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  AUTH_MAIL_TRANSPORT: '',
  AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
  AUTH_APP_NAME: 'User Service',
  AUTH_MAIL_ALLOWLIST: '',
  AUTH_VERIFY_EMAIL_ACTION_URL: '',
  AUTH_RESET_PASSWORD_ACTION_URL: '',
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_SECURE: '',
} satisfies NonSecretProfile);

// Sandbox defaults: verified-email policy with the Resend transport selected
// explicitly. The recipient allowlist is intentionally empty here and must be
// supplied out-of-band per deployment; delivery without one fails closed.
// SMTP slots stay explicitly unset until a deployment selects the SMTP
// transport (ticket #58). Auth action URL slots stay explicitly unset so
// sandbox mail targets the service-owned fallback pages unless a deployment
// configures branded consumer pages (ticket #77).
export const SANDBOX_PROFILE: NonSecretProfile = freezeProfile({
  ENVIRONMENT: 'sandbox',
  AUTH_REGISTRATION_ENABLED: 'true',
  AUTH_EMAIL_PASSWORD_ENABLED: 'true',
  AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  AUTH_MAIL_TRANSPORT: 'resend',
  AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
  AUTH_APP_NAME: 'User Service',
  AUTH_MAIL_ALLOWLIST: '',
  AUTH_VERIFY_EMAIL_ACTION_URL: '',
  AUTH_RESET_PASSWORD_ACTION_URL: '',
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_SECURE: '',
} satisfies NonSecretProfile);

// Production defaults: verified-email policy with the Resend transport. The
// allowlist slot stays empty because production deliveries are not
// allowlist-guarded; sandbox/production secrets still live outside this file.
// SMTP slots stay explicitly unset until a deployment selects the SMTP
// transport (ticket #58). Auth action URL slots stay explicitly unset so
// production mail targets the service-owned fallback pages unless a
// deployment configures branded consumer pages (ticket #77).
export const PRODUCTION_PROFILE: NonSecretProfile = freezeProfile({
  ENVIRONMENT: 'production',
  AUTH_REGISTRATION_ENABLED: 'true',
  AUTH_EMAIL_PASSWORD_ENABLED: 'true',
  AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  AUTH_MAIL_TRANSPORT: 'resend',
  AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
  AUTH_APP_NAME: 'User Service',
  AUTH_MAIL_ALLOWLIST: '',
  AUTH_VERIFY_EMAIL_ACTION_URL: '',
  AUTH_RESET_PASSWORD_ACTION_URL: '',
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_SECURE: '',
} satisfies NonSecretProfile);

export const ENVIRONMENT_PROFILES: Record<CanonicalEnvironment, NonSecretProfile> = {
  local: LOCAL_PROFILE,
  sandbox: SANDBOX_PROFILE,
  production: PRODUCTION_PROFILE,
};
