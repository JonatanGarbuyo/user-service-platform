# ADR-0001: Cloudflare Workers and Hono

## Status
Accepted

## Context

The service must be independently deployable, inexpensive at low traffic, simple to operate, and suitable for a single-client deployment. Avoiding VM/OS administration is a material benefit.

## Decision

Use Cloudflare Workers as the initial application runtime and Hono as the HTTP framework.

Do not introduce a heavier application framework such as NestJS unless a concrete requirement demonstrates that its dependency-injection/module/runtime model provides material value that cannot be obtained cleanly with the existing architecture.

## Consequences

- No application VM or operating system is required for the core service.
- Runtime code must remain compatible with Cloudflare Workers.
- Architectural discipline is enforced through feature ownership, contracts, tests, ADRs and dependency rules rather than a framework-level module system.
- A future runtime change remains possible because domain logic should not depend directly on Hono request objects outside HTTP boundaries.
