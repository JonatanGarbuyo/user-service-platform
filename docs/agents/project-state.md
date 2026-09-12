# Project state checkpoint

Last verified: 2026-09-12

This file is the durable operational checkpoint for starting a fresh ChatGPT/OpenCode session. It is an index and handoff, not a replacement for `CONTEXT.md`, ADRs, specs, tickets, PRs, CI, or current repository state.

## Authority and bootstrap

Use canonical sources in this order for their respective concerns:

1. `CONTEXT.md` for domain vocabulary.
2. Accepted ADRs under `docs/adr/` for architecture/technical decisions.
3. Current spec/ticket bodies plus comments for product intent.
4. Current repository HEAD, GitHub PR/issue state, CI, and exact-HEAD review evidence for implementation truth.
5. `AGENTS.md`, `docs/agents/`, `.agents/skills/`, and `.opencode/` for engineering process.
6. This file only as a cross-session handoff.

Fresh substantial sessions should read `AGENTS.md`, this file, `CONTEXT.md`, the current ticket/spec, relevant ADRs, and the applicable project-local skill. Do not reconstruct project-local workflow from model memory.

Required progression for broad work remains:

```text
wayfinder -> to-spec -> to-tickets -> implement
```

## Operating agreement

- **ChatGPT** owns design discussion, Wayfinder/spec/ticket planning, orchestration decisions, inspection of durable GitHub evidence, trusted publication where required, and final acceptance/verification.
- **OpenCode agents** are the primary implementation/correction and adversarial-review workers.
- GitHub-triggered `/agent-ticket` and `/agent-fix-cycle` are the default remote execution paths; local OpenCode is fallback/debug.
- Models do not merge, deploy, publish production infrastructure, mutate secrets, or receive unrestricted push/workflow-write credentials.
- Review and run evidence lives on GitHub; manual copy/paste into chat is not part of the normal workflow.

## Architecture baseline

Canonical detail lives in `CONTEXT.md`, ADR-0001 through ADR-0011, Wayfinder #1, and spec #8.

Key durable decisions:

- single-client reusable User Service, not multi-tenant SaaS;
- Cloudflare Workers + Hono;
- contract-first vertical slices under `/v1`;
- Zod + `@hono/zod-openapi`; generated OpenAPI and generated consumer TypeScript contracts;
- RFC 9457-compatible Problem Details with stable machine codes;
- D1 initial relational store; persistence representations stay out of domain/public contracts;
- object storage for binary files;
- Better Auth behind application-owned identity/session boundaries;
- deployment-owned `AuthPolicy`;
- verified email required before initial email/password login/session;
- application-owned `AuthMailer`, with production transport hidden behind an adapter;
- local / sandbox / production are isolated operational contexts; sandbox and production never share mutable resources or credentials;
- production is an explicit promotion step;
- D1 migrations use rollback-compatible evolution and D1 Time Travel for emergency recovery;
- Cloudflare-native logs/traces/metrics are the initial observability baseline;
- credentials, cookies, session tokens, verification/reset secrets/action URLs, and email bodies are excluded from ordinary logs.

ADR-0008 is authoritative for the environment naming. Historical `staging` references in spec #8 are superseded by the terminology amendment comment on that issue and should be read as `sandbox`.

## Toolchain and TypeScript guidance

ADR-0006 is authoritative:

- Node.js 24 LTS; `.nvmrc` currently pins 24.21.0.
- TypeScript 6.x.
- ESLint flat config + `typescript-eslint`.
- Prettier is the sole formatter.
- Semicolons, single quotes, two-space indentation, 100-column print width.
- npm.
- Drizzle preferred for D1, subject to Better Auth/Workers compatibility gates.

Project-local `.agents/skills/better-typescript/` is the shared TypeScript design/reference skill for local and GitHub-hosted OpenCode runs. Agents writing or reviewing TypeScript should consult its router and load only applicable technique sections.

Concrete model assignments are deliberately not duplicated here; read live `.opencode/agents/*`, `.opencode/commands/*`, and `docs/agents/opencode.md`.

## Product frontier

Verified on 2026-09-12:

- #9 health endpoint: closed/completed.
- #10 register + verify email: closed/completed.
- #11 sign in/current User: closed/completed; PR #43 squash-merged.
- #12 password recovery: implementation is PR #46 at exact HEAD `6e3430d8a924d6b271c0aaa2463f9f167e7d9cd2`. `agent-fix-cycle` run `34722805060` reached READY with repository gates, exact-HEAD CI, Standards, and Spec all passing. ChatGPT final acceptance is PASS and PR #46 is no longer draft. The remaining step is the human-controlled merge; close #12 afterward if GitHub does not do so automatically.
- #13 production auth email: next product ticket. It remains formally blocked only until #12 is merged/closed; terminology is local/sandbox/production.
- #14 sandbox promotion: blocked by #13 (and therefore indirectly by the pending #12 merge); canonical target is sandbox, not staging.

Do **not** reimplement #12. Its implementation and acceptance evidence are complete on exact HEAD `6e3430d8a924d6b271c0aaa2463f9f167e7d9cd2`; preserve that accepted HEAD through merge.

Expected product sequence:

```text
human merge PR #46 / close #12
  -> /agent-ticket on #13 production auth email
       -> accept/merge #13
            -> /agent-ticket on #14 sandbox promotion
```

## Remote execution/review gate

Durable accepted tooling:

- #31 event-driven status/watchdogs: closed.
- #36 least-privilege trusted workflow-file publication: closed.
- #40 complete notification-first run status: closed.
- #44 narrow trusted exact-HEAD CI approval for eligible agent-created PRs: closed.
- #47 action-required CI recovery: closed; the recovered #12 / PR #46 dogfood subsequently reached READY through run `34722805060`, validating the approval/review path on the preserved exact HEAD.

Review invariants:

- Standards and Spec are independent axes.
- review markers are exact-HEAD; stale markers never satisfy a new HEAD.
- corrections rerun both axes.
- local/repository gates plus exact-HEAD CI are required before READY.
- safe-push is deterministic repo code; models do not get generic push.
- `.github/workflows/**` corrections stop at #36 trusted-publication handoff.
- no automated merge/deploy/secret mutation.

### Current orchestration state

There is no active orchestration blocker on the accepted #12 implementation. The only remaining #12 transition is the human-controlled merge of PR #46 and ticket closure. Once #12 is closed, #13 is the dependency frontier and should be started with the normal GitHub-triggered `/agent-ticket` path.

## Maintenance debt

Open but not the immediate product frontier:

- #37 `Upgrade GitHub Actions to Node 24-native releases` — workflow maintenance; #36 publication policy is already available, so its old blocker wording is stale and should not be treated as an active dependency.
- #38 `Audit deprecated transitive dependencies and npm security findings` — dependency/tooling hygiene; no forced `npm audit fix --force` or blind compatibility-breaking upgrade.

## Maintaining this checkpoint

Update this file when product frontier, execution/review workflow, environment terminology, or a cross-session blocker changes materially. Do not duplicate volatile model assignments or full ADR/spec/ticket bodies here.
