import {
  ENVIRONMENT_PROFILES,
  LOCAL_PROFILE,
  NON_SECRET_VAR_NAMES,
  type CanonicalEnvironment,
  type NonSecretProfile,
} from './profiles.js';

// Resolved operational context. `test` is the isolated automated-test
// context: it reuses the local non-secret shape but is never a deployment
// target. The legacy `staging` runtime value normalizes to `sandbox`; no
// staging profile, variable or documentation is introduced.
export type ResolvedEnvironment = CanonicalEnvironment | 'test';

export interface EffectiveConfig {
  readonly environment: ResolvedEnvironment;
  // Merged non-secret configuration only. Secrets passed alongside the
  // runtime input are never copied here; callers hand them directly to the
  // identity resolvers that require them.
  readonly config: NonSecretProfile;
}

export interface ResolveEffectiveConfigInput {
  readonly environment?: string;
  // Raw runtime values (Worker bindings, `.env` overrides, Wrangler vars).
  // Only string values under known non-secret names are merged; everything
  // else (secrets, bindings, unknown keys) is ignored by construction.
  readonly runtime?: Record<string, unknown>;
}

// Normalizes a raw environment name (`parseDontValidate`: returns the
// refined value instead of check-and-forget). Unknown names fail early with
// a redacted error that names the canonical environments but never echoes
// the offending value.
function normalizeEnvironmentName(value: string | undefined): ResolvedEnvironment {
  const normalized = (value ?? 'local').trim().toLowerCase();
  if (normalized === 'local') {
    return 'local';
  }
  if (normalized === 'sandbox') {
    return 'sandbox';
  }
  if (normalized === 'production') {
    return 'production';
  }
  if (normalized === 'staging') {
    return 'sandbox';
  }
  if (normalized === 'test') {
    return 'test';
  }
  throw new Error(
    'Configuration error: ENVIRONMENT must be one of "local", "sandbox" or "production".',
  );
}

function parseBooleanFlag(name: string, value: string): void {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'false') {
    return;
  }
  throw new Error(`Configuration error: ${name} must be "true" or "false".`);
}

function validateProfile(config: NonSecretProfile): void {
  parseBooleanFlag('AUTH_REGISTRATION_ENABLED', config.AUTH_REGISTRATION_ENABLED);
  parseBooleanFlag('AUTH_EMAIL_PASSWORD_ENABLED', config.AUTH_EMAIL_PASSWORD_ENABLED);
  parseBooleanFlag('AUTH_REQUIRE_EMAIL_VERIFICATION', config.AUTH_REQUIRE_EMAIL_VERIFICATION);
  const transport = config.AUTH_MAIL_TRANSPORT.trim().toLowerCase();
  if (transport !== '' && transport !== 'inmemory' && transport !== 'resend') {
    throw new Error(
      'Configuration error: AUTH_MAIL_TRANSPORT must be "inmemory" or "resend" when set.',
    );
  }
}

// Resolves the effective non-secret configuration: the selected
// environment's complete profile with same-name runtime values overlaid.
// This is the single parse-and-validate entry point for effective
// configuration; every failure is a redacted `Error` carrying variable names
// and expected shapes, never runtime values.
export function resolveEffectiveConfig(input: ResolveEffectiveConfigInput): EffectiveConfig {
  const environment = normalizeEnvironmentName(input.environment);
  const base = environment === 'test' ? LOCAL_PROFILE : ENVIRONMENT_PROFILES[environment];
  const merged: NonSecretProfile = { ...base };
  const runtime = input.runtime ?? {};
  for (const name of NON_SECRET_VAR_NAMES) {
    const value: unknown = runtime[name];
    if (typeof value === 'string') {
      merged[name] = value;
    }
  }
  validateProfile(merged);
  return { environment, config: merged };
}

// Application-boundary guard for request paths that still consume raw Worker
// bindings: parses and validates the effective non-secret configuration once
// and fails early. Secrets in the input are ignored here and continue to
// flow directly to the identity resolvers.
export function assertValidNonSecretConfig(runtime: Record<string, unknown>): void {
  const environment: unknown = runtime.ENVIRONMENT;
  resolveEffectiveConfig({
    environment: typeof environment === 'string' ? environment : undefined,
    runtime,
  });
}
