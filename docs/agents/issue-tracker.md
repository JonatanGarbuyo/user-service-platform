# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues.

## Conventions

- Publish specs as GitHub issues.
- Publish implementation work as one issue per tracer-bullet vertical slice.
- Keep blockers explicit. Prefer GitHub native issue dependencies/sub-issues when available; otherwise record `Blocked by` references in issue bodies.
- Pull requests are not a feature-request/triage surface by default.

## Wayfinding operations

The canonical Wayfinder map is a GitHub issue labelled `wayfinder:map` when repository labels are available.

Decision tickets are child/sub-issues of the map and use one of these logical types:

- `wayfinder:research`
- `wayfinder:prototype`
- `wayfinder:grilling`
- `wayfinder:task`

If repository labels or native dependency APIs are unavailable in the current client, preserve the same semantics explicitly in issue bodies until they can be applied.

A decision ticket is resolved by recording its answer, closing it, and adding a short linked gist to the map's `Decisions so far` section.

## Specs and implementation tickets

`to-spec` publishes the implementation-ready specification to GitHub Issues.

`to-tickets` then creates narrow, complete tracer-bullet tickets. Each ticket must describe externally verifiable behaviour and list its blockers. Horizontal tickets such as "build repositories", "build controllers", or "build database layer" are not acceptable unless they are a justified mechanical refactor.
