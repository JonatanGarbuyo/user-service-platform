# Local development runbook

Runs the verified-email Identity service from a clean local checkout without
depending on Cloudflare-hosted mutable resources (ticket #57, spec #8,
ADR-0008). Local persistence uses Wrangler/workerd local D1; no Dockerized
or standalone SQLite service is introduced. The same versioned `./drizzle`
migrations consumed by sandbox/production initialize local D1.

Canonical environments are **local / sandbox / production**. Never introduce
`staging` terminology into new configuration or documentation; the runtime
still accepts the legacy `staging` value as a sandbox context, but local
practice uses `local` only.

## 1. Configure local overrides and secrets

```bash
cp .env.example .env
```

`.env` lives at the repository root, is ignored by Git, and is loaded by
`npm run dev:local` (`wrangler dev --env-file .env`). Every `AUTH_*` name in
it matches the canonical runtime variable name used by the versioned
environment profiles in `src/config/profiles.ts`, so a same-name value
overrides the selected profile without translation. Sandbox/production
secrets are configured directly in Cloudflare and never belong in `.env`.

- Non-secret scenario toggles (for example `AUTH_REGISTRATION_ENABLED=false`)
  take effect on the next request; restart `wrangler dev` after editing.
- `BETTER_AUTH_SECRET` may stay empty locally (a documented dev-only value
  is used); sandbox/production fail closed without an explicit secret.
- The mail transport stays unset locally so the metadata-only development
  sink is used: no credentials, no network delivery. Real-delivery
  acceptance is owned by later tickets.

Invalid or incomplete effective configuration fails early with a redacted
configuration error (variable names and expected shapes only; values,
secrets, tokens and addresses are never echoed).

## 2. Persistent local-development path (ordinary restarts keep data)

Local D1 state persists under `.wrangler/` across restarts. From a fresh
clone:

```bash
npm run db:local:migrate
npm run dev:local
```

`db:local:migrate` applies the versioned migrations to local D1
(`wrangler d1 migrations apply DB --local`). It never takes `--remote` or
`--env`, so remote databases cannot be affected. Leave the Worker running
and iterate; local rows survive ordinary restarts until a reset is
requested.

## 3. Clean/reset path (reproducibility from an empty database)

```bash
npm run db:local:reset
npm run dev:local
```

`db:local:reset` (`scripts/reset-local-d1.ts`) deletes Wrangler's persisted
local D1 state and reapplies the versioned migrations to an empty database,
then the Worker starts against that fresh state. Only paths under the local
`.wrangler/` directory are removed; the script takes no remote flags. If a
previous `wrangler dev` is still running, stop that process first so the old
workerd does not keep serving on the same port.

## 4. Prove a clean boot through the real HTTP boundary

With the Worker running against fresh local D1:

```bash
curl -s http://localhost:8787/v1/health
# {"status":"ok", ...}

curl -s -i http://localhost:8787/v1/me
# HTTP/1.1 401 Unauthorized with an application/problem+json body whose
# machine code is "unauthenticated".
```

Both checks go through the real Worker HTTP boundary: health proves routing
and the composed application boot, while anonymous `/v1/me` proves the
unauthenticated identity boundary returns the stable RFC 9457 contract.
Authenticated and mail-delivery journeys are owned by the follow-up tickets
(#58 mail transports, #59 admin bootstrap, #60 full local acceptance).

To prove same-name local overrides work, set a single value in `.env` and
restart:

```bash
# in .env:
AUTH_REGISTRATION_ENABLED=false
```

```bash
curl -s -X POST http://localhost:8787/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"name":"Local Probe","email":"probe@example.com","password":"correct-horse-9"}'
# HTTP 403 with machine code "registration-disabled".
```

Remove the override (or restore `true`) and restart to return to the
profile defaults.

## 5. Bootstrap the first administrator

With the Worker running against fresh local D1 (sections 2–3), create the
first administrative User through the auth engine (ticket #59, spec #8):

```bash
ADMIN_NAME="Site Admin" ADMIN_EMAIL="admin@example.com" \
  ADMIN_PASSWORD="correct-horse-41" npm run admin:bootstrap
```

`npm run admin:bootstrap` (`scripts/bootstrap-admin.ts`) posts explicit
operator inputs to `POST /v1/auth/admin/bootstrap` on the running Worker
(`ADMIN_BOOTSTRAP_BASE_URL`, default `http://localhost:8787`). The first
call succeeds with the application-owned admin representation
(`role: "admin"`); no migration seeds credentials and the repository defines
no default admin password. The bootstrapped administrator remains subject
to the deployment email-verification policy and completes verification
before signing in.

The operation is first-admin-wins: repeats or conflicting identities fail
with explicit machine codes (`admin-already-bootstrapped`,
`admin-email-conflict`, exit code 2) instead of duplicating privileged
accounts. The script logs only method, path, status and stable codes —
never names, addresses, passwords, tokens or action URLs.

## 6. Confirm the gates before handing off

```bash
npm run check        # lint + formatting
npm run typecheck
npm test             # Workers-runtime suite (config, identity, contracts)
npm run test:harness # whole-Worker harness + Node suite
npm run openapi:check # generated OpenAPI artifact has no drift
```

Real external mail delivery is never part of these gates: automated tests
use isolated/in-memory mail, and the full real-transport acceptance lives in
ticket #60.
