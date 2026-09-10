# ADR-0006: Use ESLint and Prettier for repository consistency

## Status

Accepted.

## Context

The service is intended to be extended by multiple developers and agents over time. Repository consistency must be enforced mechanically rather than through review comments or personal editor settings.

JavaScript Standard Style was considered because its low-configuration philosophy and recognizable no-semicolon style are attractive. The project, however, is TypeScript-first and also needs room for architecture-specific lint rules as vertical slices and dependency boundaries are introduced.

`ts-standard` provides a StandardJS-like TypeScript experience, but its published toolchain is less current and less directly extensible than using modern ESLint and `typescript-eslint` configuration. The project also wants formatting to remain a separate concern from semantic/code-quality linting.

## Decision

Use:

- ESLint flat configuration for correctness and maintainability rules;
- `typescript-eslint` for TypeScript-aware linting;
- Prettier as the sole formatter;
- `eslint-config-prettier` to avoid lint/format rule conflicts;
- EditorConfig for basic editor-independent whitespace consistency.

Adopt a StandardJS-inspired surface style where practical: no semicolons, single quotes, two-space indentation, and minimal stylistic bikeshedding. Prettier is authoritative for formatting; ESLint is authoritative for code-quality and architecture rules.

The initial lint configuration is intentionally independent of the application `tsconfig` because the runtime project has not yet been scaffolded. Once the TypeScript project exists, typed linting must be enabled and CI must run it with zero warnings.

Architectural import/dependency rules will be added after the vertical-slice filesystem contract is finalized; they must be machine-enforced rather than merely documented.

## Consequences

- Contributors run `npm run check` before proposing changes.
- CI will eventually make lint, formatting, typecheck, tests and contract checks mandatory.
- Formatting changes are deterministic and should not consume code-review discussion.
- We retain the ability to add rules for feature boundaries, forbidden imports, generated files and contract ownership.
- TypeScript is pinned to a version supported by the selected `typescript-eslint` release rather than blindly following the `latest` npm tag.

## Revisit triggers

Reconsider the tooling only if maintenance burden, runtime/tool compatibility, or measurable developer friction outweighs the value of the current setup. Style preferences alone are not sufficient reason to replace the toolchain.
