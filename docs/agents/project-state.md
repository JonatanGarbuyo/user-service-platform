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

- **ChatGPT** owns design discussion, Wayfinder/spec/ticket planning, orchestration decisions, inspection of durable GitHub evidence, trusted publication where required, final acceptance/verification, and may perform the final PR merge through a separately authorized GitHub operation once the agreed gates are satisfied and no human decision remains pending.
- **OpenCode agents** are the primary implementation/correction and adversarial-review workers.
- GitHub-triggered `/agent-ticket` and `/agent-fix-cycle` are the default remote execution paths; local OpenCode is fallback/debug.
- OpenCode/model-run agents and repository automation do **not** merge, deploy, publish production infrastructure, mutate secrets, or receive unrestricted push/workflow-write credentials. They stop at `READY FOR FINAL ACCEPTANCE`.
- “No automated merge” means the agent/workflow cannot self-merge. It does not prohibit ChatGPT, acting as the separately authorized final operator, from merging an accepted PR with an exact expected HEAD.
- Deployment, production-infrastructure mutation, and secret mutation remain separately controlled even after final acceptance; merge authority does not imply deployment authority.
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

ADR-0008 is authoritative for environment naming. Historical `staging` references in spec #8 are superseded by the terminology amendment comment and should be read as `sandbox`.

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
- #12 password recovery: closed/completed. PR #46 was accepted on exact HEAD `6e3430d8a924d6b271c0aaa2463f9f167e7d9cd2` after Standards, Spec, repository gates, and exact-HEAD CI all passed, then ChatGPT performed the final squash merge with expected-head protection. Main commit: `588d7e653daf00c7c9e209cc6295f7843c56b359`.
- #13 production auth email: current product frontier; #10 and #12 are closed and its `ready-for-agent` label is present. Launch through `/agent-ticket`.
- #14 sandbox promotion: blocked by #13; canonical target is sandbox, not staging.

Expected product sequence:

```text
/agent-ticket on #13 production auth email
  -> dual review + exact-HEAD CI + ChatGPT final acceptance/merge
       -> /agent-ticket on #14 sandbox promotion
```

## Remote execution/review gate

Durable accepted tooling:

- #31 event-driven status/watchdogs: closed.
- #36 least-privilege trusted workflow-file publication: closed.
- #40 complete notification-first run status: closed.
- #44 narrow trusted exact-HEAD CI approval for eligible agent-created PRs: closed.
- #47 action-required CI recovery: closed; PR #46 subsequently reached READY through run `34722805060` on its preserved exact HEAD.
- #37 Node-24-native GitHub Actions upgrade: closed/completed. The #36 trusted-publication artifact was published byte-for-byte, PR #50 passed correction/gates/Standards/Spec/exact-HEAD CI on `f2d6533e03e1d16310e7a92e7ac0dbc11b76a46d`, and ChatGPT performed the final squash merge with expected-head protection. Main commit: `5e71c8b9f36a8a140916a9ec5f90719253b71204`.

Review invariants:

- Standards and Spec are independent axes.
- review markers are exact-HEAD; stale markers never satisfy a new HEAD.
- corrections rerun both axes.
- repository gates plus exact-HEAD CI are required before READY.
- safe-push is deterministic repo code; model-run agents do not get generic push.
- `.github/workflows/**` corrections stop at the #36 trusted-publication handoff unless a separately authorized trusted operator publishes the verified artifact.
- agent/workflow execution never self-merges, deploys, or mutates secrets.
- final merge by ChatGPT is allowed only after final acceptance, with the expected HEAD supplied to the GitHub merge operation so a moved PR fails closed.

### Current orchestration state

There is no active orchestration blocker. #12 and #37 are complete. #13 is the dependency frontier and should run through the normal GitHub-triggered `/agent-ticket` path.

## Maintenance debt

Open but not the immediate product frontier:

- #38 `Audit deprecated transitive dependencies and npm security findings` — dependency/tooling hygiene; no forced `npm audit fix --force` or blind compatibility-breaking upgrade. Avoid running it concurrently with a product ticket when lockfile/dependency churn would create unnecessary overlap.

## Maintaining this checkpoint

Update this file when product frontier, execution/review workflow, environment terminology, final-operator authority, or a cross-session blocker changes materially. Do not duplicate volatile model assignments or full ADR/spec/ticket bodies here.
