# Research: environments, observability, and operational baseline

## Question

What operational baseline should this single-client Cloudflare Workers service adopt for local development, staging, production, releases, migrations, recovery, and observability?

## Primary sources

- Cloudflare Workers environments: https://developers.cloudflare.com/workers/wrangler/environments/
- Wrangler configuration: https://developers.cloudflare.com/workers/wrangler/configuration/
- Workers versions and deployments: https://developers.cloudflare.com/workers/versions-and-deployments/
- Workers rollbacks: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
- D1 migrations: https://developers.cloudflare.com/d1/reference/migrations/
- D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/
- Workers observability: https://developers.cloudflare.com/workers/observability/
- Workers Logs: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- Workers traces: https://developers.cloudflare.com/workers/observability/traces/
- Workers metrics: https://developers.cloudflare.com/workers/observability/metrics-and-analytics/
- Workers OpenTelemetry export: https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/

## Findings

### Environments are independent deployed Workers

Wrangler environments create separately configured Workers, conventionally named from the base Worker plus the environment name. Environment-specific bindings and variables that are not inheritable must be declared explicitly. This supports a staging/production split without adding another runtime platform.

### Storage state is not part of a Worker version

Workers versions capture code/configuration state, but associated D1/R2 state is not versioned with Worker deployments. A Worker rollback therefore does not undo a database migration or object-storage mutation. Cloudflare warns that rolling back code against a changed data shape can cause errors.

This makes backward-compatible schema evolution a release requirement, not merely a preferred migration style.

### D1 already provides versioned migrations and point-in-time recovery

D1 migrations are versioned SQL files applied sequentially and tracked in the database. Current D1 also supports nested migration layouts such as Drizzle-generated migration directories.

D1 Time Travel is always enabled. On Workers Paid it provides point-in-time restore to any minute within the previous 30 days; the Free plan retention is shorter. Restore is destructive to the target database, so production recovery needs an explicit runbook and operator confirmation.

### Cloudflare can be the initial observability backend

Workers provides native invocation/custom/error logs, request and performance metrics, and automatic traces of Workers and connected bindings/subrequests. This is sufficient as an initial operational baseline without making Sentry, Honeycomb, Grafana, or another vendor a core dependency.

Workers can export logs and traces through OpenTelemetry/OTLP if external retention, alerting, querying, or cross-system correlation becomes valuable. As of September 2026, Workers OTel export covers logs and traces, not Worker/custom metrics.

## Decision: environment topology

Use three operational contexts:

1. **local** — Wrangler/local Worker runtime and local D1 state for development/tests;
2. **staging** — deployed Cloudflare Worker with staging-only D1, R2, secrets, domains/routes, and configuration;
3. **production** — deployed Cloudflare Worker with production-only D1, R2, secrets, domains/routes, and configuration.

Staging and production must never share mutable D1 databases, R2 buckets, credentials, or auth/email secrets.

Do not create ephemeral per-PR Cloudflare infrastructure in the initial version. Pull requests run static checks/tests. This can be revisited if integration testing against deployed Workers becomes materially valuable.

## Decision: release and migration policy

- All database schema changes are version-controlled migrations.
- CI validates migrations against a disposable/local D1 database before merge.
- Merging to `main` is eligible to deploy to staging automatically once deployment automation exists.
- Production deployment is an explicit promotion/release step, not an automatic consequence of every merge to `main`.
- Production release records the source commit and resulting Worker version/deployment identifier.
- Smoke tests run after staging and production deployment.

Schema evolution follows **expand -> deploy -> contract** when compatibility matters:

1. add backward-compatible schema first;
2. deploy code that can operate with the expanded schema;
3. remove old fields/constraints only in a later release after no serving Worker version depends on them.

A migration and application version must remain compatible with at least the immediately preceding production Worker version whenever a code rollback could plausibly be required.

Do not rely on `wrangler rollback` as a database rollback. D1 Time Travel is the emergency data-recovery mechanism and must be used only through the documented recovery runbook.

## Decision: observability contract

Cloudflare-native observability is the initial backend. Application logs are structured and designed for future OTLP export.

Every request should be attributable through a correlation/request identifier. Operational log records should include, when applicable:

- timestamp (provided by the platform/log backend);
- environment;
- service/release or Worker version identifier when available;
- request/correlation id;
- HTTP method and stable route/operation id, not uncontrolled raw URL data when it could contain sensitive values;
- response status;
- duration;
- stable application problem/error code;
- safe feature/domain identifiers needed for diagnosis.

Never log passwords, cookies/session tokens, OAuth credentials, verification/reset tokens, authorization headers, email bodies, or secrets. Avoid logging raw personal data when a stable internal identifier is sufficient.

Use Cloudflare traces for request-flow diagnosis and Workers metrics for request volume, error rate, CPU/wall time and execution behavior. Sampling/retention may differ by environment and must be configurable through deployment config rather than feature code.

OTLP export is an infrastructure option, not a domain dependency. Add an external observability provider only when concrete retention, alerting, cross-service correlation, or operational-query requirements justify it.

## Decision: audit and analytics boundaries

Operational logs are not the product analytics store.

Do not introduce a generic application audit table before a durable audit requirement exists. Security/commercial state transitions that must be durable should be represented by their owning domain model/events. A future admin/operator feature may add a dedicated audit trail because its requirements differ from Worker diagnostic logs.

## Health/readiness

Expose a lightweight liveness endpoint that proves the Worker/router is running without mutating dependencies.

If a readiness endpoint is introduced, it may validate required bindings/configuration and carefully selected dependency access, but it must not create a high-frequency expensive database workload. Health endpoints must be uncached and must not expose secrets or internal topology.

## Minimum production runbook

Before the first production release, repository documentation must explain how to:

- deploy and identify the currently serving version;
- apply and inspect D1 migrations for the correct environment;
- perform a Worker code rollback and understand its data limitations;
- inspect Workers Logs, traces, and metrics using a request/correlation id;
- use D1 Time Travel to identify a restore point and restore after explicit confirmation;
- rotate application/provider secrets;
- verify service health after deployment/recovery.

## Deferred

- External observability vendor and OTLP destination.
- Automated gradual/canary deployment; Cloudflare supports it, but it is not required for the initial single-client service.
- Ephemeral per-PR environments.
- Long-term D1 backups beyond native Time Travel retention; add export/archive only if retention requirements demand it.
