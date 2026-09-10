# Research: API contract and code generation

## Question

What repeatable contract/code-generation pattern should every Hono vertical slice follow?

## Primary sources

- Hono Zod OpenAPI example: https://hono.dev/examples/zod-openapi
- `@hono/zod-openapi` package: https://www.npmjs.com/package/@hono/zod-openapi
- OpenAPI TypeScript: https://openapi-ts.dev/introduction
- openapi-fetch: https://openapi-ts.dev/openapi-fetch/
- OpenAPI Specification: https://spec.openapis.org/oas/
- RFC 9457 Problem Details: https://www.rfc-editor.org/rfc/rfc9457.html

## Findings

### Runtime contracts and OpenAPI can share one schema

Hono's official `@hono/zod-openapi` integration defines request/response schemas with Zod, registers a typed route with `createRoute`, validates request input at runtime, and generates an OpenAPI document from the same route definition. This avoids maintaining a separate hand-written API schema.

The package is actively maintained and supports current Hono/Zod releases. Its documented limitation around mixing plain `Hono` and `OpenAPIHono` routers is important for our architecture: contract-bearing feature routers should use the OpenAPI-aware router consistently so their definitions are not lost when mounted.

### OpenAPI should be the language-neutral integration artifact

The OpenAPI Specification is explicitly designed as a language-agnostic description of an HTTP interface and as input for documentation, client generation and testing tools. This is a better cross-repository boundary than exporting Hono server types directly to consumers.

The service may use Hono's internal type inference for implementation ergonomics, but external clients must not depend on the server's source tree or Hono-specific inferred types.

### TypeScript client generation can stay lightweight

`openapi-typescript` generates runtime-free TypeScript types from OpenAPI 3.x. `openapi-fetch` consumes those generated `paths` types while using the platform `fetch` API at runtime. This avoids generating a large custom HTTP runtime while retaining path, parameter, request-body and response type safety.

For the initial consumer ecosystem (Astro/TypeScript), this is preferable to a large multi-language generator. The OpenAPI document remains available if a future non-TypeScript consumer needs another generator.

### Error contracts should be uniform

RFC 9457 defines `application/problem+json` as a standard machine-readable representation for HTTP API errors. A shared Problem Details schema with application-specific stable error codes gives every slice the same error envelope without inventing per-feature error formats.

Human-readable `detail` text must not be used as a machine contract. Clients should branch on HTTP status plus stable problem type/code fields.

## Decision

Adopt the following pattern:

1. Each public feature owns explicit Zod request and response schemas. Persistence/Drizzle row types are never public contracts.
2. Each public operation is registered with `@hono/zod-openapi` using `createRoute` and an `OpenAPIHono` feature router.
3. Runtime validation and OpenAPI generation derive from those same schemas.
4. The API is namespaced under `/v1` from the first release.
5. The generated OpenAPI document is a versioned build artifact and may also be served by the service.
6. TypeScript clients are generated with `openapi-typescript`; runtime requests use `openapi-fetch`.
7. Generated client code/types are outputs, never edited by hand and never treated as the source of truth.
8. Errors use an RFC 9457-compatible Problem Details contract with stable application problem identifiers/codes.

## Compatibility policy

Within `/v1`, changes are backward compatible by default. Examples of compatible changes include adding optional response fields, adding endpoints, and adding optional request parameters where their absence preserves existing behaviour.

Removing or renaming fields/endpoints, changing field meaning/type, making optional inputs required, or materially changing response semantics is breaking. Breaking changes require an explicitly versioned API transition (normally `/v2`) and a migration/deprecation plan rather than silently changing `/v1`.

The SDK package/artifact version follows semantic versioning independently of the route prefix:

- major: breaking client/API contract change;
- minor: backward-compatible endpoint/schema capability;
- patch: implementation/client-generation fixes that preserve the contract.

## CI contract gates

Once executable scaffolding exists, CI must:

1. run lint/format/typecheck/tests;
2. generate OpenAPI from source contracts;
3. validate the OpenAPI document;
4. generate TypeScript API types/client artifacts;
5. fail if committed generated contract artifacts differ from generation output;
6. run contract/integration tests through the public HTTP boundary rather than testing route internals only.

A compatibility-diff gate should be added before the first external consumer is pinned to `/v1`; breaking schema diffs must require an explicit versioning decision.

## Deferred choices

- npm/GitHub Packages versus another distribution mechanism for a reusable SDK;
- whether generated SDK artifacts are committed or produced only in release CI after the initial integration workflow is proven;
- the exact OpenAPI compatibility-diff tool.

Those choices do not change the contract ownership model and can be decided when release automation is designed.
