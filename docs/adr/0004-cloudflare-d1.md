# ADR-0004: Use Cloudflare D1 as the initial relational store

- Status: Accepted
- Date: 2026-09-09

## Context

The User Service is a single-client Cloudflare Workers application. Its expected relational workload is dominated by identity/session data, subscription state, follows, bookmarks, preferences and audience queries. Analytics storage is explicitly outside this service.

The principal alternatives considered were Cloudflare D1 and external PostgreSQL accessed from Workers through Hyperdrive.

## Decision

Use Cloudflare D1 as the initial relational database.

D1 keeps the service fully Cloudflare-native, removes a third-party database dependency, has very low operational overhead and cost, and is adequate for the expected single-client workload.

Persistence details must not leak into public contracts or domain types. Feature slices depend on narrow persistence boundaries so a future database migration does not require redesigning HTTP contracts or domain behaviour.

## Consequences

- Sandbox and production use independent D1 databases.
- Database schema and migrations are version controlled.
- SQL and persistence code should avoid unnecessary coupling to D1-specific behaviour where doing so does not provide meaningful value.
- D1 limits are accepted deliberately rather than treated as equivalent to a general-purpose PostgreSQL deployment.

## Revisit triggers

Reopen this decision if measured production needs show any of the following:

- database size approaching D1 limits;
- sustained concurrency or write contention that materially affects service SLOs;
- transaction requirements that cannot be expressed safely with D1's model;
- required PostgreSQL-specific features or integrations;
- a platform requirement for database portability that outweighs Cloudflare-native simplicity;
- a future architecture change from single-client deployments to a shared large multi-tenant data plane.

At that point PostgreSQL via Hyperdrive is the preferred alternative to evaluate; Better Auth and public API contracts should remain replaceable independently of the database.
