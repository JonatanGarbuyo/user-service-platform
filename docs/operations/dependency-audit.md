# Dependency audit — deprecated packages and npm security findings

Ticket: #38. Scope: dependency/tooling hygiene only; no User Service product/API behavior changes.

Audited: 2026-09-13, Node 24.21.0, npm 11.19.0, clean `npm ci` baseline.
Direct dependencies at audit time: `drizzle-kit@0.31.10`, `wrangler@4.130.0`,
`@cloudflare/vitest-pool-workers@0.22.0`, `better-auth@1.7.4`,
`@better-auth/drizzle-adapter@1.7.4`, `drizzle-orm@0.45.2`.

No audit output is suppressed or hidden: `npm audit` still reports the 8 findings
below. Each has an explicit disposition with a revisit trigger.

## Deprecated packages

`npm ci` reports:

- `@esbuild-kit/esm-loader@2.6.5` — "Merged into tsx: https://tsx.hirok.io"
- `@esbuild-kit/core-utils@3.3.2` — "Merged into tsx: https://tsx.hirok.io"

Source confirmed from `package-lock.json` and `npm ls` (the repository does not
directly declare `@esbuild-kit/*`):

```text
drizzle-kit@0.31.10 (`@esbuild-kit/esm-loader: ^2.5.5`)
└── @esbuild-kit/esm-loader@2.6.5
    └── @esbuild-kit/core-utils@3.3.2 (`esbuild: ~0.18.20`)
        └── esbuild@0.18.20
```

`drizzle-kit@0.31.10` is the latest stable release on its line, so there is no
stable compatible Drizzle Kit release that removes this chain. The `1.0.0-rc`
prerelease line was evaluated and rejected for this ticket: ADR-0006 requires
the stable Drizzle 0.45.x / Drizzle Kit 0.31.x lines that Better Auth declares
compatible (`drizzle-kit >=0.31.4`, `drizzle-orm ^0.45.2`), and an RC migration
is a major rewrite needing full Better Auth/Drizzle/Workers compatibility
verification, not a hygiene-task upgrade.

## Audit findings

`npm audit` reports 8 findings (4 moderate, 4 high), all dev-only. None touch
production runtime dependencies (`hono`, `@hono/zod-openapi`, `better-auth`,
`drizzle-orm`, `zod` are not in any finding path).

### Drizzle chain (4 moderate)

| Finding                                                                                          | Dependency path                                                                                                                                                                 | Exposure / exploitability                                                                                                                                                                                             | Fixed version                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-kit` (moderate, via `@esbuild-kit/esm-loader`)                                          | root devDep `drizzle-kit@0.31.10`                                                                                                                                               | Local migration CLI only; never runs in the Worker or serves network traffic.                                                                                                                                         | Audit suggests `0.18.1` — a downgrade, rejected (see below).                                                                                                                                                                            |
| `@esbuild-kit/esm-loader` (moderate, via `@esbuild-kit/core-utils`)                              | `drizzle-kit` → `@esbuild-kit/esm-loader@2.6.5`                                                                                                                                 | Same local-CLI-only exposure as above.                                                                                                                                                                                | Same `drizzle-kit@0.18.1` downgrade; rejected.                                                                                                                                                                                          |
| `@esbuild-kit/core-utils` (moderate, via `esbuild`)                                              | `drizzle-kit` → `esm-loader` → `@esbuild-kit/core-utils@3.3.2`                                                                                                                  | Same local-CLI-only exposure.                                                                                                                                                                                         | Same downgrade; rejected.                                                                                                                                                                                                               |
| `esbuild` GHSA-67mh-4wv8-2f99 (moderate, CVSS 5.3; dev-server request forgery; range `<=0.24.2`) | nested `esbuild@0.18.20` pinned by `@esbuild-kit/core-utils` (`~0.18.20`). The other installed esbuild copies (`0.25.12`, `0.28.1`, `0.28.2`) are outside the vulnerable range. | The vulnerable copy runs only inside drizzle-kit's local CLI loader, not as a served dev server, so the advisory's attack path (a website sending requests to the dev server) does not apply to this project's usage. | Same downgrade; rejected. A narrow override of the nested pin was evaluated and rejected: `@esbuild-kit` is deprecated/abandoned, so overriding its pinned esbuild risks breaking drizzle-kit's loader for no production-security gain. |

Disposition for all four: **accepted temporary risk, upstream-blocked**.
`npm audit fix --force` was not applied: its only offered fix is downgrading
`drizzle-kit` to `0.18.1`, which violates Better Auth's supported range
(`>=0.31.4`) and ADR-0006's stable-line policy. Revisit when a stable Drizzle
Kit release drops the `@esbuild-kit` chain.

### Cloudflare toolchain chain (4 high)

| Finding                                                                    | Dependency path                                                                                             | Exposure / exploitability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fixed version                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@cloudflare/vitest-pool-workers` (high, via `miniflare`, `wrangler`)      | root devDep `@cloudflare/vitest-pool-workers@0.22.0` (already the latest release)                           | Local test runner only; never ships to production.                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Audit suggests `0.8.30` — a downgrade out of the installed `>=0.8.31` range; rejected.                                                                                                                                                                                                                                                                    |
| `wrangler` (high, via `miniflare`)                                         | root devDep `wrangler@4.130.0`, plus nested `wrangler@4.124.0` via `vitest-pool-workers`                    | Local CLI/test harness only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Same `vitest-pool-workers@0.8.30` downgrade; rejected.                                                                                                                                                                                                                                                                                                    |
| `miniflare` (high, via `sharp`)                                            | `vitest-pool-workers` → `miniflare@5.20260815.0-alpha`; `wrangler@4.130.0` → `miniflare@5.20260908.0-alpha` | Local Worker simulator only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Newer `miniflare@5.20260911.0-alpha` (via `wrangler@4.131.1`) moves to fixed `sharp@0.35.4`, but `vitest-pool-workers@0.22.0` (latest) still pins the flagged miniflare, so a wrangler-only bump cannot clear the audit and would churn the `workerd` binary the `compatibility_date` is pinned against (see `wrangler.jsonc`). Rejected for this ticket. |
| `sharp` GHSA-rgj7-g3m4-5g8c (high; libheif heap overflow; range `<0.35.4`) | `miniflare` → `sharp@0.35.2` (exact pin by miniflare)                                                       | Native image library loaded only by the local Miniflare simulator for Workers tests; it never processes untrusted production input. A narrow `sharp → 0.35.4` override was evaluated: upstream proves the combination compatible (`miniflare@5.20260911.0-alpha` declares exactly `sharp@0.35.4`), but the override would not clear the range-based `miniflare` findings and would force a native-binary reinstall on every clean install for a test-only path. Rejected; documented as accepted risk instead. | Fixed in `sharp@0.35.4`; reachable in this tree only through a future `vitest-pool-workers` release.                                                                                                                                                                                                                                                      |

Disposition for all four: **accepted temporary risk, upstream-blocked**.
Revisit when `@cloudflare/vitest-pool-workers` ships a release whose miniflare
resolves past the flagged range with `sharp >= 0.35.4`; then re-run this audit
before adopting it (workerd/`compatibility_date` compatibility must be
re-verified per the `wrangler.jsonc` constraint).

## Install-script permissions

Before this ticket the repository had no `allowScripts` policy, so `npm ci`
silently skipped 7 install scripts and warned:

```text
esbuild@0.18.20, esbuild@0.25.12 (x2), esbuild@0.28.2, esbuild@0.28.1,
workerd@1.20260815.1, workerd@1.20260908.1 (each: postinstall `node install.js`)
```

`package.json` now carries an explicit least-privilege policy: pinned approvals
for exactly those two trusted packages, nothing else (no blanket approval, no
denials overridden):

- `esbuild` (all four installed versions) — Evan Wallace's bundler; its
  postinstall fetches the platform-native binary required by drizzle-kit,
  tsx, vitest/vite, and wrangler builds.
- `workerd` (both installed versions) — Cloudflare's Workers runtime; its
  postinstall fetches the runtime binary required by Miniflare and the
  `vitest-pool-workers` / whole-Worker harness tests.

Verified with `npm install-scripts ls` (reports no unreviewed scripts) and
`npm rebuild esbuild workerd` (approved scripts execute successfully).
`npm prune --dry-run` housekeeping applies on future upgrades: re-approving
after a version change rewrites the pin to the reviewed version.

## Verification

- `npm ci` reproduces the exact deprecated/audit state above (nothing hidden).
- `npm install-scripts ls` is clean; `npm rebuild esbuild workerd` succeeds.
- Repository quality gates and identity integration tests remain green after
  these changes (the changes are `package.json` policy plus this document;
  no dependency version or product code changed):
  - `npm run typecheck`
  - `npm run db:generate` (drizzle-kit migration generation through the
    deprecated-loader chain)
  - `npm test` (Workers Vitest integration)
  - `npm run test:harness` (whole-Worker harness)
  - `npm run check` (lint + formatting)
  - `npm run openapi:check` (generated-artifact drift check)
