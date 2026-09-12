# ADR-0004: Use Cloudflare D1 as the initial relational store

## Status

Accepted.

## Context

The User Service is a single-client deployment on Cloudflare Workers. Its initial relational workload consists of authentication records plus application data such as subscription state, follows, bookmarks, preferences, and audience/export metadata. Analytics is intentionally separate, and community/comments are not part of the initial core.

PostgreSQL remains a viable alternative through an external provider connected to Workers via Hyperdrive, but adopting it immediately would add another managed dependency and operational surface without a demonstrated requirement.

## Decision

Use Cloudflare D1 as the initial relational database.

Application code must keep public contracts and domain types independent from D1-specific persistence details. Database access should stay behind feature boundaries so that a future migration does not require changing external API contracts.

## Consequences

### Positive

- Keeps the initial service fully Cloudflare-native.
- Avoids operating or paying for an additional PostgreSQL provider.
- Avoids Hyperdrive and connection-pool complexity in the initial architecture.
- Fits the expected single-client workload and low-to-moderate write volume.
- Works naturally with Workers-based deployment and environment isolation.

### Negative

- Accepts SQLite/D1 transaction semantics and platform-specific limits.
- D1 has lower per-database capacity and concurrency ceilings than a conventional PostgreSQL service.
- Persistence becomes more Cloudflare-specific.

## Revisit triggers

Re-evaluate PostgreSQL when one or more of these conditions is observed:

- measured write concurrency or transaction requirements exceed D1's practical fit;
- the database approaches D1 capacity limits;
- PostgreSQL-specific features or extensions become materially useful;
- community/activity workloads create a substantially different persistence profile;
- reporting or external data integration materially benefits from PostgreSQL;
- portability away from Cloudflare becomes a business requirement.

The preferred migration path, if triggered, is external PostgreSQL accessed from Workers through Hyperdrive while preserving Better Auth/Hono and existing public contracts.

## Decision record

Wayfinder decision: https://github.com/JonatanGarbuyo/user-service-platform/issues/2
