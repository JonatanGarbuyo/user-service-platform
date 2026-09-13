# Sandbox release, rollback, and recovery runbook

Operates the verified-email identity service in sandbox and promotes it to
production (ticket #14, ADR-0008, ADR-0009, ADR-0010). Written so a maintainer
other than the original author can provision sandbox, deploy, inspect
failures, roll back Worker code, and initiate D1 recovery.

Canonical environments are **local / sandbox / production**. Any historical
`staging` reference elsewhere in planning history means `sandbox`.
Application code still accepts the legacy `staging` `ENVIRONMENT` value as a
sandbox context, but Wrangler configuration and this runbook use `sandbox`
only.

## 1. Isolation model

Sandbox and production are separate Cloudflare Worker environments with
separate resources. They must never share:

- D1 databases (`user-service-sandbox` vs `user-service-production`);
- R2 buckets (when user files land; relational rows stay in D1, binaries in
  object storage per ADR-0003);
- secrets (`BETTER_AUTH_SECRET`, `RESEND_API_KEY`, provider credentials);
- routes/domains and environment-specific vars (notably `AUTH_MAIL_ALLOWLIST`).

`wrangler.jsonc` is version controlled and contains **no secrets**: only
binding names, database names/ids, and non-secret vars. Secrets are set
out-of-band (section 2) and travel to CI only as repository secrets.

## 2. First-time sandbox provisioning

Prerequisites: a Cloudflare account with Workers Paid (D1 Time Travel
retention beyond Free), `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
stored as repository secrets, and a verified Resend sender domain for sandbox.

```bash
# 1. Create the sandbox database (run once; do not reuse the production one).
npx wrangler d1 create user-service-sandbox

# 2. Record the returned database_id in wrangler.jsonc under env.sandbox.
#    Database ids are not secrets and are committed to source control.

# 3. Set sandbox secrets (never commit these; never reuse production values).
npx wrangler secret put BETTER_AUTH_SECRET --env sandbox
npx wrangler secret put RESEND_API_KEY --env sandbox

# 4. Set the sandbox sender/allowlist to sandbox-only values, e.g. via the
#    Cloudflare dashboard or wrangler vars, then confirm:
npx wrangler deploy --env sandbox --dry-run
```

Repository secrets required for automation:

| Secret                       | Purpose                                            |
| ---------------------------- | -------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`       | Wrangler deploys and D1 migration applies          |
| `CLOUDFLARE_ACCOUNT_ID`      | Account scope for Wrangler                         |
| `SANDBOX_BASE_URL`           | Deployed sandbox origin for the smoke test         |
| `SANDBOX_SMOKE_EMAIL_DOMAIN` | Sandbox-allowlisted domain for smoke registrations |

Sandbox mail must stay allowlisted: `AUTH_MAIL_ALLOWLIST` covers only
operator/test domains, and any delivery outside it is skipped with
`auth-mail.sandbox-skipped` telemetry before reaching Resend (ADR-0010).

## 3. Release procedure

### 3.1 Sandbox release (automatic)

Merging to `main` triggers `.github/workflows/deploy-sandbox.yml`, which in
order:

1. validates D1 migrations against a disposable local D1
   (`wrangler d1 migrations apply DB --local`);
2. applies versioned migrations to sandbox
   (`wrangler d1 migrations apply DB --env sandbox --remote`);
3. deploys the Worker (`wrangler deploy --env sandbox`);
4. records the deployment (`wrangler deployments list --env sandbox`);
5. runs the sandbox smoke test (`npm run smoke:sandbox`).

Identify the serving version at any time with:

```bash
npx wrangler deployments list --env sandbox
```

### 3.2 Worker code rollback (code only, never data)

A Worker rollback reverts code/configuration to a prior version. It does
**not** revert D1 or R2 state (ADR-0008). Roll back only onto a migration
state the old code understands; migrations must stay compatible with at
least the immediately preceding Worker version (section 4).

```bash
# List versions, then roll back sandbox code to a known-good version.
npx wrangler deployments list --env sandbox
npx wrangler rollback --env sandbox
```

After rollback, re-run the smoke test (section 6) and confirm the
`email-verification-required` gate still behaves; a rollback that meets a
newer data shape can produce errors instead of silently succeeding.

### 3.3 Production promotion (explicit, human-controlled)

Production is never deployed by merging, by the sandbox workflow, or by any
push trigger. Promotion runs only via `.github/workflows/promote-production.yml`
(`workflow_dispatch`) with two inputs: the `source_commit` SHA (must be an
ancestor of `main`, verified in-workflow) and `confirm_production` set to the
literal `PROMOTE`. The workflow applies production D1 migrations, deploys
`--env production`, and prints the source commit plus the resulting
deployment list as the release record. Record both identifiers in the
release notes.

## 4. D1 migrations

Migrations live versioned under `./drizzle` (generated by
`npm run db:generate` from `src/features/identity/schema.ts`) and are
consumed unchanged by local tests, sandbox, and production
(`migrations_dir: drizzle` in every `wrangler.jsonc` environment).

```bash
# Inspect what would apply (repeat per environment).
npx wrangler d1 migrations list DB --env sandbox --remote

# Validate against disposable local state before merge (also runs in CI deploy).
npx wrangler d1 migrations apply DB --local

# Apply to an environment (sandbox is automated; production via promotion).
npx wrangler d1 migrations apply DB --env sandbox --remote
```

Schema evolution follows **expand -> deploy -> contract** whenever rollback
compatibility could matter:

1. add backward-compatible schema first (new nullable columns/tables);
2. deploy code that operates with the expanded schema;
3. remove obsolete fields/constraints only in a later release, after no
   serving Worker version depends on them.

Never couple a destructive migration to the code release that stops using
the old shape. CI applies the same `./drizzle` files to the isolated test
database, so a migration that breaks the identity flow fails before merge.

## 5. D1 Time Travel recovery

D1 Time Travel is the emergency point-in-time data-recovery mechanism. Restore
is destructive to the target database, so it requires explicit operator
confirmation and a recorded restore point.

```bash
# 1. Identify the restore point (bookmark id) preceding the incident.
#    See https://developers.cloudflare.com/d1/reference/time-travel/
npx wrangler d1 time-travel info user-service-sandbox

# 2. Confirm the incident scope, the bookmark, and that sandbox (not
#    production) is the target. Get a second maintainer to acknowledge for
#    production restores.

# 3. Restore the target database to the bookmark.
npx wrangler d1 time-travel restore user-service-sandbox --bookmark <bookmark-id>

# 4. Verify: re-run the smoke test (section 6) and inspect logs/traces for
#    the affected request ids (section 7).
```

Notes:

- Retention is 30 days on Workers Paid and shorter on Free; sandbox
  incidents older than retention need the export/archive path, which is
  deferred until retention requirements demand it (ADR-0008).
- Restoring data does not roll back Worker code; if the incident involved a
  schema change, align the serving Worker version with the restored shape
  first (section 3.2).
- Production restores additionally require the release record (source commit
  - deployment id, section 3.3) so the post-restore state is attributable.

## 6. Sandbox smoke test

```bash
export SMOKE_SANDBOX_BASE_URL="https://<sandbox-worker>.workers.dev"
export SMOKE_SANDBOX_EMAIL_DOMAIN="ops.example.org"  # sandbox-allowlisted only
# Optional: complete the full verify -> sign-in path with a token pasted from
# the allowlisted mailbox. Without it the smoke proves the verification gate.
export SMOKE_VERIFICATION_TOKEN="<token-from-allowlisted-mailbox>"
npm run smoke:sandbox
```

The smoke verifies, in order: `GET /v1/health`, anonymous `GET /v1/me`
(`401 unauthenticated`), registration (`201`, unverified), pre-verification
login rejected (`403 email-verification-required`), resend accepted (`202`),
and — with the token — verification, sign-in, and authenticated
`GET /v1/me` (`200`). It refuses non-sandbox recipients, non-HTTP(S)
targets, and localhost (unless `SMOKE_ALLOW_LOCALHOST=true`), and logs only
method, path, status, and stable problem codes. Run it after every sandbox
deploy, Worker rollback, and D1 recovery.

## 7. Logs, traces, and metrics

Cloudflare-native observability is the baseline (ADR-0009), enabled via the
top-level `observability.enabled` flag in `wrangler.jsonc`:

- **Logs**: `npx wrangler tail --env sandbox` for live logs, or the
  Cloudflare dashboard Workers Logs for persisted queries. Correlate with
  the `requestId` field every application log record carries.
- **Traces**: automatic request traces in the dashboard show the Worker and
  binding/subrequest flow for a failing `requestId`.
- **Metrics**: Workers metrics cover request volume, error rate, CPU/wall
  time, and execution behavior; alerting/export beyond this needs an
  explicit OTLP decision, not feature-code changes.

Redaction rules (enforced by tests): application and mail logs carry
`requestId`, method, stable route, status, and stable problem codes only.
Credentials, cookies, session tokens, verification/reset tokens and action
URLs, email bodies, and provider secrets must never appear. Query strings
are not logged by application code.

## 8. Secret rotation

```bash
# Rotate without committing: set the new value, redeploy, verify.
npx wrangler secret put BETTER_AUTH_SECRET --env sandbox
npx wrangler secret put RESEND_API_KEY --env sandbox
npx wrangler deploy --env sandbox
npm run smoke:sandbox
```

Rotate `BETTER_AUTH_SECRET` and `RESEND_API_KEY` independently; sandbox and
production values are distinct and rotated separately. After rotation,
confirm the smoke passes and that `auth-mail.failed` telemetry does not
spike for the allowlisted domain.

## 9. Post-deploy and post-recovery verification

After any deploy, rollback, migration, or restore:

1. `npx wrangler deployments list --env sandbox` identifies the serving version;
2. `npm run smoke:sandbox` proves health plus the verified-email gate;
3. Workers Logs/traces for the smoke `requestId`s show no `error` records
   and no redaction violations;
4. `npx wrangler d1 migrations list DB --env sandbox --remote` shows no
   unapplied migrations.
