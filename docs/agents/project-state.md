# Project state checkpoint

Last verified: 2026-09-12

This file is the durable operational checkpoint for starting a fresh ChatGPT/OpenCode session. It is an index and handoff, not a replacement for the domain glossary, ADRs, specs, tickets, PRs, CI, or current repository state.

## Authority and drift rules

Use the right source for the right kind of truth:

1. **Domain vocabulary**: `CONTEXT.md`.
2. **Accepted architecture/technical decisions**: accepted ADRs under `docs/adr/`.
3. **Product/spec intent**: the current approved spec and implementation ticket, including comments.
4. **Actual implementation and live workflow state**: current repository HEAD, GitHub issue/PR state, CI, and exact-HEAD review evidence.
5. **Engineering process**: `AGENTS.md`, `docs/agents/`, and project-local skills under `.agents/skills/`.
6. **This file**: a session-bootstrap snapshot and cross-session operating handoff.
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
- Wayfinder resolves decisions; it does not silently implement the destination.
- Work at most one non-research Wayfinder decision ticket per session unless the user explicitly changes the process.

Required progression:

```text
wayfinder -> to-spec -> to-tickets -> implement
```

Do not skip from a broad idea directly to implementation.

### Specs and tickets

- Before producing a spec, read `.agents/skills/to-spec/SKILL.md`.
- Before decomposing work, read `.agents/skills/to-tickets/SKILL.md`.
- `to-tickets` produces narrow, complete tracer-bullet vertical slices with explicit blockers, not horizontal controller/service/repository tasks.
- The proposed ticket granularity and blocking edges are reviewed with the user before publishing.
- GitHub Issues is the configured tracker.

### Implementation

- OpenCode is the primary implementation/correction harness.
- Before implementation, read the implementation ticket, parent spec, `AGENTS.md`, `CONTEXT.md`, relevant ADRs, and `.agents/skills/implement/SKILL.md`.
- Use TDD at the pre-agreed highest practical seam where possible.
- Implement one approved `ready-for-agent` ticket per isolated ticket branch/context.
- Implementation may commit and enter adversarial review; it does not merge, deploy, publish, or mutate production infrastructure/secrets.

## Operating agreement: ChatGPT and OpenCode

This is an explicit project decision and must survive chat compaction.

- **ChatGPT** owns design discussion, Wayfinder/spec/ticket planning, orchestration decisions, inspection of durable GitHub evidence, and final acceptance/verification.
- **OpenCode agents** are the primary code builders/correctors and review workers.
- ChatGPT should hand approved implementation tickets to repository-owned OpenCode automation rather than manually implement product tickets unless the user explicitly asks otherwise.
- Review findings and execution evidence live durably on GitHub; manual copy/paste into chat is not part of the normal workflow.
- Product, architecture, public-contract, infrastructure-provider, or security-policy decisions stop automation and return to planning.
- Once issue #31 is accepted, GitHub-triggered `/agent-ticket` and `/agent-fix-cycle` are the default execution path. Local OpenCode remains the fallback/debug path.

## Product and architecture baseline

The completed Wayfinder map is issue #1. The parent implementation spec is issue #8, `Spec: Foundation and verified-email identity walking skeleton`.

Accepted baseline:

- Single-client reusable User Service; not multi-tenant SaaS.
- Cloudflare Workers + Hono runtime.
- Contract-first vertical feature slices.
- Public APIs under `/v1`.
- Application-owned Zod contracts registered through `@hono/zod-openapi`; OpenAPI is generated, not hand-maintained.
- Consumer TypeScript contracts come from generated OpenAPI, not server implementation imports.
- Public application errors follow RFC 9457-compatible Problem Details with stable machine-readable identifiers/codes.
- Cloudflare D1 is the initial relational store; persistence/ORM row types do not become public/domain contracts.
- Binary user files belong in object storage; relational storage holds references/metadata.
- Better Auth owns identity/session mechanics behind application-owned boundaries; feature slices do not depend on Better Auth persistence/provider internals.
- `AuthPolicy` is the deployment-owned authentication policy surface.
- Initial deployment uses email/password registration and requires verified email before email/password login/session establishment.
- `AuthMailer` is the application-owned transactional-auth mail boundary; provider SDK/types stay inside adapters.
- Auth mail is scheduled outside the synchronous request path through Workers execution context.
- Resend is the conservative initial production transport recommendation; it is an adapter choice, not a domain/public contract.
- Do not introduce Cloudflare Queues solely for initial auth mail; durable queueing requires demonstrated reliability need.
- Local/staging/production mutable resources and credentials are isolated; production is explicitly promoted rather than automatically deployed from merge.
- D1 migrations are version controlled and rollback-compatible; D1 Time Travel is the recovery mechanism.
- Initial operational observability is Cloudflare-native logs/traces/metrics; product analytics is a separate concern.
- Credentials, cookies, session tokens, verification/reset tokens/action URLs, email bodies, and other secrets must not enter ordinary logs/traces.
- Internal operator/admin authentication and admin UI are deferred from the initial core.
- Editorial CMS roles, newsletter delivery, analytics-platform ownership, hard premium-content protection, and multi-tenant SaaS are outside the initial service boundary.

Canonical detail lives in `CONTEXT.md`, ADR-0001 through ADR-0011, Wayfinder issue #1, and spec issue #8.

## Toolchain baseline

ADR-0006 is authoritative:

- Node.js 24 LTS; `.nvmrc` currently pins 24.21.0.
- TypeScript 6.0.x while TypeScript 7 ecosystem compatibility is not yet accepted.
- ESLint flat config + `typescript-eslint` for correctness/maintainability/architecture checks.
- Prettier is the sole formatter.
- Formatting: **semicolons**, single quotes, two-space indentation, 100-column print width.
- npm is the package-manager baseline.
- Drizzle is preferred for D1; dependency versions must remain compatible with Better Auth and pass repository typecheck/integration gates.
- Do not upgrade TypeScript/ORM/auth/test tooling independently just because a newer version exists; compatibility is accepted through repository gates.

Issue #8 contains historical no-semicolon prose that is superseded by ADR-0006, `AGENTS.md`, and repository configuration.

## Current product frontier

Verified against GitHub on 2026-09-12:

- #9 `Serve a contract-tested Worker health endpoint`: closed/completed.
- #10 `Register and verify an email identity`: closed/completed.
- #11 `Sign in and resolve the current User`: open, `ready-for-agent`, next product frontier.
- #12 `Recover a password safely`: blocked by #11.
- #13 `Deliver production authentication email`: blocked by #12 (and #10, already complete).
- #14 `Promote the identity service to staging`: blocked by #11, #12, and #13.

Expected sequence:

```text
#11 sign in/current User
  -> #12 password recovery
       -> #13 production auth email
            -> #14 staging promotion
```

Do not start a ticket before its declared blockers are complete.

## Agent and reviewer configuration

Concrete models are deliberately **not duplicated in this checkpoint** because model availability and assignments are operational and can change quickly.

Before launching implementation or review, read the live repository configuration:

- `.opencode/agents/*`
- `.opencode/commands/*`
- `docs/agents/opencode.md`
- `docs/agents/review-cycle.md`

Role separation remains durable even if the underlying models change: implementation/correction, Standards review, and Spec review are distinct executions/contexts with their own responsibilities and exact-HEAD evidence.

## Review gate

- `npm run review:cycle` is deterministic repository code, not an LLM orchestrator.
- Standards and Spec are independent axes.
- Reviews are tied to exact HEAD with machine-readable markers; stale markers do not satisfy a new HEAD.
- Valid blocking findings may invoke `/address-review` for the smallest in-scope correction, after which both axes rerun on the new HEAD.
- Correction cycles and marker retries are bounded.
- Local gates and exact-HEAD CI must pass before `READY FOR FINAL ACCEPTANCE`.
- Automated push is only through repository-owned safe-push guards; models do not receive unrestricted `git push`.
- No automated merge/deploy/publish/secret mutation.

## Remote GitHub execution

Issue #29 established the remote control surface:

```text
/agent-ticket      # approved ready-for-agent issue
/agent-fix-cycle   # open same-repository PR targeting main
```

The comment text is a fixed trigger for repository-owned workflows, never arbitrary shell/prompt input. Runs use isolated GitHub-hosted runners, repository GitHub credentials for ordinary GitHub operations, and the configured OpenCode provider secret. Production Cloudflare/D1/email/deploy/package credentials must not be available to these jobs.

After issue #31 is accepted, this remote GitHub path becomes the default implementation/correction path. Local OpenCode is the fallback/debug path.

## Immediate tooling blockers before #11 remote dogfood

Issue #31 (`Add event-driven status and watchdogs to remote agent runs`) and PR #34 are not yet accepted.

Final acceptance found a real completed-stage observability gap. A subsequent `/agent-fix-cycle` produced a corrected local commit on the ephemeral runner and all repository gates passed, but publishing that correction failed.

The failure is now confirmed from Actions logs: GitHub rejected the push because the correction modifies `.github/workflows/agent-fix-cycle.yml` and the workflow's GitHub App/token lacks permission to create/update workflow files. This is a security/automation-boundary problem, not a safe-push branch-validation failure.

Do not solve this by exposing a broad PAT or unrestricted workflow-write credential to the model process. The workflow-file mutation path needs an explicit least-privilege design before remote correction can be considered complete.

Do not launch #11 through remote dogfood until #31/#34 are corrected, reviewed on the corrected exact HEAD, accepted, and merged/closed as appropriate.

## Current GitHub Actions maintenance debt

Verified from the same Actions run on 2026-09-12:

- the project runtime itself is correctly Node 24.21.0;
- `actions/checkout@v4`, `actions/setup-node@v4`, and `actions/upload-artifact@v4` still target the deprecated Node 20 Action runtime and GitHub is currently forcing them to Node 24;
- those old Action internals emit `punycode` / `url.parse()` deprecation warnings under Node 24;
- `npm ci` also reports separate deprecated transitive packages, audit findings, and install-script allowlist warnings. Those are application/tool dependency-hygiene concerns and must be investigated separately from GitHub Action runtime upgrades.

Track and remove this debt rather than silencing warnings or setting `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION`.

## Maintaining this checkpoint

Update this file whenever one of these changes materially:

- product implementation frontier;
- ChatGPT/OpenCode operating agreement;
- repository-owned execution/review workflow;
- a known stale source or active blocker is discovered that is likely to mislead a fresh session;
- a cross-session decision matters for bootstrap but does not belong in `CONTEXT.md` or an ADR.

Do **not** duplicate volatile model assignments or full ADR/spec/ticket bodies here. Point to their canonical live artifacts.

Before ending a long planning/orchestration chat, explicitly reconcile this checkpoint with decisions made during the session. This is a required project handoff/compaction step.