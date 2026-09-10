# ADR-0009: Use Cloudflare-native observability as the initial operational backend

## Status

Accepted.

## Context

The service needs enough observability for a developer other than the original author to diagnose failures and operate releases. At the same time, observability must remain distinct from product analytics and should not force a third-party monitoring vendor into the application architecture before one is needed.

Cloudflare Workers provides native logs, traces, request/performance metrics, and OpenTelemetry export for logs and traces.

## Decision

Use Cloudflare Workers observability as the initial backend for operational logs, traces, and platform metrics.

Application logs are structured and must include a request/correlation id plus stable route/operation and error/problem identifiers where relevant. Release/environment metadata should be included when available so incidents can be tied to a deployed version.

Never log credentials, authorization/session tokens, OAuth secrets, password-reset or verification tokens, cookies, email bodies, or other secrets. Avoid raw personal data when a stable internal identifier is enough to diagnose the event.

Cloudflare automatic traces are the default request-flow tracing mechanism. Workers metrics are the default source for service-level traffic, error-rate, CPU/wall-time, and execution behavior.

External observability is an infrastructure/export concern. If future requirements exceed Cloudflare-native retention, alerting, querying, or cross-service correlation, export logs/traces using OTLP rather than coupling feature code to a vendor SDK.

Operational telemetry is not product analytics. Do not build product funnels or audience analytics from Worker diagnostic logs.

A generic durable audit table is not part of the initial core. Domain state that requires durable history belongs to the owning feature/event model; a future operator/admin module may introduce its own explicit audit contract.

## Health and runbooks

The service exposes a lightweight liveness capability without mutating dependencies. Any future readiness check must avoid becoming an expensive high-frequency D1 query and must not reveal internal topology or secrets.

Before production, repository runbooks must cover deployment/version identification, migration inspection/application, code rollback limitations, D1 Time Travel recovery, secret rotation, log/trace investigation, and post-deploy/recovery health verification.

## Consequences

- No Sentry/Honeycomb/Grafana dependency is required in the initial application.
- Logging fields and redaction rules are part of the engineering contract and are testable where practical.
- Sampling/retention can be configured by environment without changing business feature code.
- OTLP remains an available escape hatch for more demanding operations later.

## Research

See `docs/research/environments-observability-operations.md`.
