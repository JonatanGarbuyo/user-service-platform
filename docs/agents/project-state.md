# Project state checkpoint

Last verified: 2026-09-12

This file is the durable operational checkpoint for starting a fresh ChatGPT/OpenCode session. It is intentionally a compact index and handoff, not a replacement for the domain glossary, ADRs, specs, implementation tickets, PRs, or current repository state.

## Authority and drift rules

Use the right source for the right kind of truth:

1. **Domain vocabulary**: `CONTEXT.md`.
2. **Accepted architecture/technical decisions**: accepted ADRs under `docs/adr/`.
3. **Product/spec intent**: the current approved spec and implementation ticket, including comments.
4. **Actual implementation and live workflow state**: current repository HEAD, GitHub issue/PR state, CI, and exact-HEAD review evidence.
5. **Engineering process**: `AGENTS.md`, `docs/agents/`, and the project-local skills under `.agents/skills/`.
6. **This file**: a session-bootstrap snapshot that points to the sources above and records cross-session operating agreements.
7. **Chat history/summaries**: useful context, but never stronger authority than the versioned artifacts above.

When this file conflicts with a newer accepted ADR, ticket, PR/HEAD, or repository configuration, update this file rather than treating the snapshot as authoritative.

## Fresh-session bootstrap

Before substantial work, read at minimum:

1. `AGENTS.md`.
2. This file.
3. `CONTEXT.md`.
4. The current issue/spec in full, including relevant comments.
5. Relevant accepted ADRs.

Do not reconstruct project process from model memory when the repository contains the corresponding project-local skill.

### Planning and Wayfinder

For broad product/architecture work:

- Read `.agents/skills/wayfinder/SKILL.md` before using Wayfinder.
- Read `.agents/skills/domain-modeling/SKILL.md` whenever domain vocabulary or decisions are being sharpened.
- For HITL/grilling Wayfinder decisions, use the repository's `grilling` and `domain-modeling` disciplines together as required by the Wayfinder skill.
- Use the project-local `research` or `prototype` skill when the Wayfinder ticket type requires it.
- Wayfinder is for resolving decisions, not silently implementing the destination.
- Work at most one non-research Wayfinder decision ticket per session unless the user explicitly changes the process.

The required planning progression is:

```text
wayfinder -> to-spec -> to-tickets -> implement
```

Do not skip from a broad idea directly to implementation.

### Specs and tickets

- Before producing a spec, read `.agents/skills/to-spec/SKILL.md`.
- Before decomposing work, read `.agents/skills/to-tickets/SKILL.md`.
- `to-tickets` must produce narrow, complete tracer-bullet vertical slices with explicit blockers, not horizontal controller/service/repository tasks.
- `to-tickets` includes a human granularity/blocking-edge review before publishing the ticket set.
- GitHub Issues is the configured tracker; specs and implementation tickets live there.

### Implementation

- OpenCode is the primary implementation harness.
- Before implementation, read the implementation ticket, parent spec, `AGENTS.md`, `CONTEXT.md`, relevant ADRs, and `.agents/skills/implement/SKILL.md`.
- Use TDD at the pre-agreed highest practical seam where possible.
- Implementation is one approved `ready-for-agent` ticket per isolated ticket branch/context.
- Implementation ends in a commit and adversarial review; it does not merge, deploy, publish, or mutate production infrastructure/secrets.

## Operating agreement between ChatGPT and OpenCode

Recovered from the project workflow and prior project conversation; keep this section explicit because it is easy to lose in chat compaction.

- **ChatGPT** owns design discussion, Wayfinder/spec/ticket planning, orchestration decisions, inspection of durable GitHub evidence, and final acceptance/verification.
- **OpenCode agents** are the primary code builders/correctors and independent review workers.
- ChatGPT should prefer handing approved implementation tickets to repository-owned OpenCode automation rather than manually implementing product tickets, unless the user explicitly asks otherwise.
- Review findings and execution evidence should live on the PR/GitHub run, not require manual copy/paste back into chat.
- Human-required product, architecture, public-contract, infrastructure-provider, or security-policy decisions stop automation and return to planning.

**Needs user confirmation:** whether remote GitHub-triggered execution should become the default implementation path immediately after issue #31 is accepted, with local OpenCode retained mainly as a fallback/debug path.

## Product and architecture baseline

The completed Wayfinder map is issue #1. The parent implementation spec is issue #8, `Spec: Foundation and verified-email identity walking skeleton`.

Accepted baseline:

- Single-client reusable User Service; not multi-tenant SaaS.
- Cloudflare Workers + Hono runtime.
- Contract-first vertical feature slices.
- Public APIs under `/v1`.
- Application-owned Zod contracts registered through `@hono/zod-openapi`; OpenAPI is generated, not hand-maintained.
- Consumer TypeScript contracts come from OpenAPI (`openapi-typescript` / `openapi-fetch` direction), not server implementation imports.
- Public application errors follow RFC 9457-compatible Problem Details with stable machine-readable application identifiers/codes.
- Cloudflare D1 is the initial relational store; persistence row/ORM types do not become public/domain contracts.
- Binary user files belong in object storage, with relational storage holding references/metadata only.
- Better Auth owns identity/session mechanics behind application-owned boundaries; feature slices must not depend on Better Auth persistence/provider internals.
- `AuthPolicy` is the deployment-owned authentication policy surface.
- Initial deployment uses email/password registration and requires verified email before email/password login/session establishment.
- `AuthMailer` is the application-owned transactional-auth mail boundary; provider SDK/types stay inside adapters.
- Auth mail is scheduled outside the synchronous request path through Workers execution context.
- Resend is the conservative initial production transport recommendation; it is an adapter decision, not a domain/public contract. Cloudflare Email Sending remains a future adapter candidate while its maturity warrants caution.
- Do not introduce Cloudflare Queues solely for initial auth mail; durable queueing requires a demonstrated reliability need.
- Local/staging/production mutable resources and credentials are isolated; production is explicitly promoted rather than automatically deployed from merge.
- D1 migrations are version controlled and rollback-compatible using expand/deploy/contract where required; D1 Time Travel is the recovery mechanism.
- Initial operational observability is Cloudflare-native logs/traces/metrics; analytics storage/reporting is explicitly a separate concern.
- Secrets, credentials, cookies, session tokens, verification/reset tokens/action URLs, and email bodies must not enter ordinary logs/traces.
- Internal operator/admin authentication and admin UI are deferred from the initial core.
- Editorial CMS roles, newsletter delivery, analytics platform ownership, hard premium-content protection, and multi-tenant SaaS are outside the initial service boundary.

Canonical detail lives in `CONTEXT.md`, ADR-0001 through ADR-0011, Wayfinder issue #1, and spec issue #8.

## Toolchain baseline

Current accepted tooling decision is ADR-0006, not older prose in issue #8:

- Node.js 24 LTS; `.nvmrc` baseline is Node 24.21.0.
- TypeScript 6.0.x through the official compatibility package while TypeScript 7 ecosystem compatibility is not yet accepted.
- ESLint flat config + `typescript-eslint` for correctness/maintainability/architecture checks.
- Prettier is the sole formatter.
- Formatting policy: **semicolons**, single quotes, two-space indentation, 100-column print width.
- npm is the package manager baseline.
- Drizzle is preferred for D1; initial compatibility baseline is stable Drizzle 0.45.x / Drizzle Kit 0.31.x, gated by repository typecheck/integration tests with Better Auth and Workers tooling.
- Do not upgrade TypeScript/ORM/auth/test tooling independently just because a newer version exists; compatibility is accepted through repository gates.

### Known stale statement

Issue #8 still contains an older `StandardJS-inspired: no semicolons` sentence. It is superseded by accepted ADR-0006, `AGENTS.md`, repository formatting configuration, and the implemented ticket policy requiring semicolons. Do not resurrect the no-semicolon rule from the old spec prose.

## Current implementation status and product frontier

Verified against GitHub on 2026-09-12:

- #9 `Serve a contract-tested Worker health endpoint`: **closed/completed**.
- #10 `Register and verify an email identity`: **closed/completed**.
- #11 `Sign in and resolve the current User`: **open, ready-for-agent, next product frontier**.
- #12 `Recover a password safely`: open; blocked by #11.
- #13 `Deliver production authentication email`: open; blocked by #10 and #12, therefore currently blocked by #12.
- #14 `Promote the identity service to staging`: open; blocked by #11, #12, and #13.
- Parent spec #8 remains open while the walking skeleton sequence is incomplete.

Expected product sequence from the current frontier:

```text
#11 sign in/current User
  -> #12 password recovery
       -> #13 production auth email
            -> #14 staging promotion
```

Do not start #12/#13/#14 before their declared blockers are complete.

## Agent/review runtime baseline

Current project-local OpenCode model ownership:

```text
implementer/correction -> opencode/muse-spark-1.3-contributor-free
Standards reviewer      -> opencode/mimo-v2.5-free
Spec reviewer           -> opencode/muse-spark-1.3-contributor-free
```

The implementation/correction and Spec roles intentionally share Muse Spark 1.3, but remain separate executions with separate prompts, contexts, permissions, responsibilities, and exact-HEAD result markers. Standards remains a separate model family.

Model assignments are operational and may change faster than architecture. Before launching work, verify `.opencode/agents/*.md`, `.opencode/commands/*.md`, and `docs/agents/review-cycle.md`; update this snapshot when assignments change.

### Review gate

- `npm run review:cycle` is deterministic repository code, not an LLM orchestrator.
- Standards and Spec are independent axes.
- Reviews are tied to exact HEAD and use machine-readable markers; stale markers do not satisfy a new HEAD.
- Valid blocking findings may invoke `/address-review` for the smallest in-scope correction, then both axes rerun on the new HEAD.
- Correction cycles and marker retries are bounded.
- Local gates and exact-HEAD CI must pass before `READY FOR FINAL ACCEPTANCE`.
- Automated push is only through repository-owned safe-push guards; models do not receive unrestricted `git push`.
- No automated merge/deploy/publish/secret mutation.

Older issues/docs naming Nemotron, DeepSeek, or North as the Spec reviewer are historical. Issue #32 superseded those operational model choices with Muse Spark 1.3.

## Remote GitHub execution

Issue #29 established the intended remote control surface:

```text
/agent-ticket      # on an approved ready-for-agent issue
/agent-fix-cycle   # on an open same-repository PR targeting main
```

The command text is a fixed trigger for repository-owned workflows, never arbitrary shell/prompt input. Runs use an isolated GitHub-hosted runner, `GITHUB_TOKEN` for GitHub operations, and `OPENCODE_ZEN_API_KEY` as the only model-provider secret. Production Cloudflare/D1/email/deploy/package credentials must not be available to these jobs.

The intended first full remote product dogfood is `/agent-ticket` on #11, but only after the current #31/#34 tooling blocker is accepted.

## Immediate tooling blocker before #11

Issue #31 (`Add event-driven status and watchdogs to remote agent runs`) is still open and PR #34 is still draft.

Final acceptance found a real status-surface gap in the first #31 implementation:

- `review:cycle` did not accumulate completed stages in the durable status surface.
- terminal `/agent-fix-cycle` status could fall back to `Completed: (see run log)`, violating the requirement that GitHub mobile/web expose enough state without opening runner logs.

A second `/agent-fix-cycle` generated a correction locally on its Actions runner and repository quality gates passed, but the deterministic safe-push step failed before publishing the correction to the PR. The subsequent dual review was therefore skipped and PR #34 remained on the previous remote HEAD.

**Operational rule:** do not treat #31 as accepted and do not launch #11 through the remote dogfood flow until the safe-push failure is diagnosed, the correction is durably pushed, both review axes and exact-HEAD CI pass on the new HEAD, final acceptance succeeds, and #31/#34 are merged/closed as appropriate.

## Known documentation drift to avoid

- `docs/agents/opencode.md` previously hardcoded #9 as the current frontier; that snapshot became stale after #9/#10 completed. Live frontier belongs in this file and GitHub, not duplicated indefinitely across process docs.
- Issue #8 contains the obsolete no-semicolon wording described above; ADR-0006 wins.
- Issue #29 refers to Nemotron 3.5 Lightning as the Spec reviewer in its historical acceptance text; issue #32 and current reviewer configuration supersede it with Muse Spark 1.3.
- Older review-tooling tickets may describe prior model assignments. Treat them as history unless current configuration or a newer accepted decision points back to them.

## How to maintain this checkpoint

Update this file when one of these changes materially:

- product implementation frontier;
- cross-session ChatGPT/OpenCode operating agreement;
- agent/model ownership;
- repository-owned execution/review workflow;
- a known stale source is discovered that is likely to mislead a fresh session;
- a new decision is important for session bootstrap but does not belong in `CONTEXT.md` or an ADR.

Do **not** duplicate full ADR/spec/ticket content here. Record the compact decision/current-state summary and point to the canonical artifact.

Before ending a long planning/orchestration chat, explicitly reconcile this checkpoint with decisions made in that session. This is the project equivalent of an agent handoff/compaction checkpoint.

## Confirmation backlog

The following item was recovered from prior project conversation context rather than a dedicated versioned decision and should be explicitly confirmed by the user:

1. After #31 is accepted, should GitHub-triggered `/agent-ticket` and `/agent-fix-cycle` be the **default** execution path, with local OpenCode kept as fallback/debug tooling?
