import type { Env } from '../../env.js';

// Dev-only signing fallback for local development and isolated tests. This
// value is not a credential: it must never be relied upon outside local/test
// contexts, and sandbox/production fail closed when BETTER_AUTH_SECRET is
// absent so a real secret cannot be silently replaced.
export const DEV_AUTH_SECRET = 'local-dev-only-insecure-secret-do-not-use-in-production';

// Resolves the Better Auth signing secret. Production-like environments fail
// closed without an explicit secret; local/test fall back to the documented
// dev-only value so tests need no secrets (ADR-0008, ADR-0010).
export function resolveAuthSecret(env: Pick<Env, 'ENVIRONMENT' | 'BETTER_AUTH_SECRET'>): string {
  const configured = env.BETTER_AUTH_SECRET;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  const environment = env.ENVIRONMENT ?? 'local';
  if (environment === 'staging' || environment === 'sandbox' || environment === 'production') {
    throw new Error(
      `BETTER_AUTH_SECRET is required in ${environment}; refusing to start without an explicit secret.`,
    );
  }
  return DEV_AUTH_SECRET;
}
