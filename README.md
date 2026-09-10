# User Service Platform

Reusable user-service foundation, initially intended for a single-client deployment.

## Status

Architecture and repository bootstrap. Product implementation must follow the decision workflow before code is added.

## Engineering workflow

This repository follows Matt Pocock's engineering skills workflow:

1. `setup-matt-pocock-skills` — configure tracker and domain docs once per repo.
2. `wayfinder` — resolve architectural/product decisions while there is still fog.
3. `to-spec` — turn settled decisions into a durable implementation specification.
4. `to-tickets` — split the spec into dependency-aware tracer-bullet vertical slices.
5. `implement` — build one ticket at a time using TDD and code review.

See `AGENTS.md`, `CONTEXT.md`, `docs/agents/`, and `docs/adr/` before making changes.

## Skills installation

For Codex and other agents supported by the open skills CLI:

```bash
npx skills@latest add mattpocock/skills \
  --agent codex \
  --skill setup-matt-pocock-skills \
  --skill wayfinder \
  --skill domain-modeling \
  --skill grill-with-docs \
  --skill research \
  --skill prototype \
  --skill to-spec \
  --skill to-tickets \
  --skill tdd \
  --skill code-review \
  --skill implement
```

The skills are project-scoped and should be committed with the repository when installed.

## Current architectural direction

- Cloudflare Workers as the deployment target.
- Hono as the HTTP framework.
- Contract-first HTTP APIs with runtime validation and generated OpenAPI.
- Vertical feature slices rather than global controller/service/repository layers.
- Object storage separate from relational data.
- Better Auth is the preferred auth candidate, but the backend/persistence decision remains explicitly tracked until accepted.
