# ADR-0002: Contract-first vertical slices

## Status
Accepted

## Context

The service is expected to grow through independent product capabilities and may later be reused in other projects. Contributors need strong extension rules without blocking legitimate new functionality.

## Decision

Organize application behaviour as vertical feature slices. Each slice owns its public contract, domain behaviour, persistence implementation, and tests.

HTTP contracts must be runtime-validatable and must generate the OpenAPI document. Generated OpenAPI is the source for client SDK generation where practical.

Do not organize the codebase around global controller/service/repository layers.

## Consequences

- Features can evolve with limited cross-feature coupling.
- Public APIs and generated clients remain synchronized with runtime validation.
- Cross-feature use occurs through explicit public interfaces.
- CI should enforce type safety, tests, generated-contract consistency, and dependency boundaries.
