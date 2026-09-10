# ADR-0011: Prove the architecture with an auth-to-me tracer bullet

## Status

Accepted.

## Context

The first implementation must validate the chosen runtime, Better Auth boundary, D1 persistence, transactional email seam, API contract generation, and observability without creating a horizontal infrastructure-only bootstrap.

Cloudflare currently recommends its Workers Vitest integration for fast unit/feature tests and `createTestHarness()` for whole-Worker integration tests.

## Decision

The first implementation tracer bullet is:

**register -> verify email -> sign in -> GET `/v1/me`**

It must prove that:

- registration follows the application `AuthPolicy`;
- verification email is dispatched through an application-owned `AuthMailer` test/development transport;
- the default policy prevents a session before email verification;
- verification enables sign-in;
- the resulting Better Auth session is translated into an application-owned authenticated-user/session context;
- `/v1/me` is described by the normal Zod/OpenAPI contract and returns that application-owned representation;
- unauthenticated access returns the standard RFC 9457 problem contract;
- D1 migrations and persistence support the full path;
- request/error telemetry carries correlation identifiers without leaking credentials or verification/reset secrets.

Use Cloudflare's Workers Vitest integration for fast tests that need the Workers runtime/bindings. Use Wrangler `createTestHarness()` for the primary end-to-end integration test through the built Worker's HTTP boundary. Tests use an in-memory/fake email transport and inspect captured delivery state without external network email.

Do not add follows, bookmarks, subscriptions, R2 avatar uploads, production email delivery, or admin behavior to this first tracer bullet.

## Consequences

- The first production-shaped code proves the architecture through user-visible behavior rather than isolated infrastructure layers.
- Later feature slices inherit a tested request/auth/D1/contract/observability skeleton.
- Integration tests remain close to the actual Workers runtime and configured bindings.
- External email is not needed to test the critical auth state transition.
