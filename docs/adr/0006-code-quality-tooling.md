# ADR-0006: Use ESLint and Prettier for repository consistency

## Status

Accepted.

## Context

The service is intended to be extended by multiple developers and agents over time. Repository consistency must be enforced mechanically rather than through review comments or personal editor settings.

The project is TypeScript-first and needs both ordinary correctness rules and architecture-specific lint rules for vertical slices, public contracts, generated artifacts, and dependency boundaries.

Biome was reconsidered when TypeScript 7 became available. At the time of this decision Biome documents TypeScript syntax support through 5.9, while `typescript-eslint` supports TypeScript versions `>=4.8.4 <6.1.0`. TypeScript 7 also lacks a stable programmatic API for ecosystem tools. For the initial release, TypeScript 6 is therefore the newest compiler line with a supported linting path for this stack.

## Decision

Use:

- ESLint flat configuration for correctness and maintainability rules;
- `typescript-eslint` for TypeScript-aware linting;
- Prettier as the sole formatter;
- `eslint-config-prettier` to avoid lint/format rule conflicts;
- EditorConfig for basic editor-independent whitespace consistency.

Formatting policy uses semicolons, single quotes, two-space indentation, and a 100-column print width. Prettier is authoritative for formatting; ESLint is authoritative for code-quality and architecture rules.

Use Node.js 24 LTS for repository tooling. `.nvmrc` pins the current project baseline to Node 24.21.0, while `package.json` restricts installs to the Node 24 major line. npm is the initial package manager and its version is pinned in `packageManager`.

Use TypeScript 6.0.x for the initial implementation. The dependency is installed through the official `@typescript/typescript6` compatibility package while TypeScript 7 owns the primary `typescript` release line. Do not upgrade to TypeScript 7 until the project's linting, ORM, auth, Worker test tooling, and editor/tool integrations have an explicitly verified compatibility path.

The initial lint configuration is intentionally independent of the application `tsconfig` because the runtime project has not yet been scaffolded. Once the TypeScript project exists, typed linting must be enabled and CI must run it with zero warnings.

Architectural import/dependency rules will be added after the vertical-slice filesystem contract exists; they must be machine-enforced rather than merely documented.

## ORM compatibility policy

Drizzle remains the preferred application ORM for D1, but version selection must respect Better Auth's supported adapter range rather than blindly following Drizzle prereleases. For the first implementation, prefer the stable Drizzle 0.45.x line and Drizzle Kit 0.31.x line that Better Auth currently declares compatible with its Drizzle adapter.

The first implementation tracer bullet must exercise TypeScript 6, Better Auth, Drizzle, D1 and the Workers test runtime together. A dependency is not considered accepted merely because its individual documentation claims compatibility; the repository's typecheck and integration suite are the compatibility gate.

## Consequences

- Contributors run `nvm use` before installing or running project tooling.
- Contributors run `npm run check` before proposing changes.
- CI will make lint, formatting, typecheck, tests and contract checks mandatory once the executable skeleton exists.
- Formatting changes are deterministic and should not consume code-review discussion.
- We retain the ability to add rules for feature boundaries, forbidden imports, generated files and contract ownership.
- TypeScript, ORM, auth and test-tool versions are pinned to mutually supported ranges instead of following `latest` independently.

## Revisit triggers

Reconsider the tooling when TypeScript 7 has a stable ecosystem integration path for this repository, or if maintenance burden, runtime/tool compatibility, or measurable developer friction outweighs the current setup. Style preferences alone are not sufficient reason to replace the toolchain.
