import type { D1Database } from '@cloudflare/workers-types';

// Worker environment bindings (ticket #9 seam). D1 is declared so isolated local
// tests resolve the binding through Wrangler/Miniflare configuration; no business
// persistence abstractions live here. The identity slice owns its Drizzle schema
// and migrations (ticket #10).
export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  // Application-owned authentication policy inputs (ADR-0005). Plain vars
  // (not secrets) using "true"/"false" strings; absent values fall back to
  // the deployment defaults resolved by the identity slice.
  AUTH_REGISTRATION_ENABLED?: string;
  AUTH_EMAIL_PASSWORD_ENABLED?: string;
  AUTH_REQUIRE_EMAIL_VERIFICATION?: string;
  // Better Auth signing secret. Required in sandbox/production; local/test
  // environments fall back to an explicit dev-only value (never a production
  // credential) so tests need no secrets.
  BETTER_AUTH_SECRET?: string;
  // Mail transport selection (ADR-0010): "inmemory" for tests, "resend" to
  // force the production Resend adapter, "smtp" to force the provider-neutral
  // SMTP adapter, unset for the local development sink. Unknown values are
  // rejected; staging/sandbox/production resolve their profile transport and
  // fail closed when its configuration is missing.
  AUTH_MAIL_TRANSPORT?: string;
  // Resend transactional-mail configuration (ticket #13). The API key is a
  // secret supplied via `wrangler secret put` or the Cloudflare dashboard and
  // must never be committed; the remaining values are deployment
  // configuration. Local/test transports never read these values.
  RESEND_API_KEY?: string;
  // Verified sender identity, for example "User Service <noreply@example.com>".
  // Required wherever the Resend transport is used.
  AUTH_MAIL_FROM?: string;
  // Branding input for application-owned mail templates. Optional; falls back
  // to a neutral product name when unset.
  AUTH_APP_NAME?: string;
  // Comma-separated sandbox recipient allowlist, for example
  // "ops@example.com,@example.org". Entries are exact emails (case-insensitive)
  // or domains ("@example.org" or "example.org"). Required and enforced
  // wherever the Resend transport runs outside production so sandbox runs
  // cannot mail arbitrary recipients.
  AUTH_MAIL_ALLOWLIST?: string;
  // User-facing auth action pages (ticket #77). Optional absolute HTTP(S)
  // action-page URLs without a token; empty means the service-owned fallback
  // browser routes (`/auth-actions/verify-email`, `/auth-actions/reset-password`)
  // on the request origin. Custom sandbox/production targets require HTTPS;
  // local/test allow plain HTTP only for localhost/loopback development.
  // Identity appends exactly one `token` query parameter from the Better Auth
  // token; the engine callback URL never becomes public contract.
  AUTH_VERIFY_EMAIL_ACTION_URL?: string;
  AUTH_RESET_PASSWORD_ACTION_URL?: string;
  // Provider-neutral SMTP transactional-mail configuration (ticket #58).
  // Host, port and TLS mode are deployment configuration; the authentication
  // credentials are secrets supplied via the ignored local `.env` or
  // `wrangler secret put` and must never be committed. Local/test transports
  // never read these values.
  // Submission hostname, for example "smtp.example.com". Required wherever
  // the SMTP transport is used.
  SMTP_HOST?: string;
  // Submission port as a decimal string. Port 587 expects STARTTLS
  // (`SMTP_SECURE=false`); port 465 expects implicit TLS (`SMTP_SECURE=true`).
  // Port 25 is rejected: Cloudflare Workers cannot deliver through it.
  SMTP_PORT?: string;
  // TLS mode: "true" for implicit TLS, "false" for STARTTLS. There is no
  // supported value that disables TLS or certificate verification.
  SMTP_SECURE?: string;
  // SMTP authentication username. A runtime secret, never versioned.
  SMTP_USER?: string;
  // SMTP authentication password. A runtime secret, never versioned.
  SMTP_PASSWORD?: string;
}
