# Project state checkpoint

Last verified: 2026-10-06

This file is the durable operational checkpoint for starting a fresh ChatGPT/OpenCode session. It is an index and handoff, not a replacement for `GLOSSARY.md`, ADRs, specs, tickets, PRs, CI, or current repository state.

## Authority and bootstrap

Use canonical sources in this order for their respective concerns:

1. `GLOSSARY.md` for domain vocabulary.
2. Accepted ADRs under `docs/adr/` for architecture/technical decisions.
3. Current spec/ticket bodies plus comments for product intent.
4. Current repository HEAD, GitHub PR/issue state, CI, and exact-HEAD review evidence for implementation truth.
5. `AGENTS.md`, `docs/agents/`, `.agents/skills/`, and `.opencode/` for engineering process.
6. This file only as a cross-session handoff.

Fresh substantial sessions should read `AGENTS.md`, this file, `GLOSSARY.md`, the current ticket/spec, relevant ADRs, and the applicable project-local skill. Do not reconstruct project-local workflow from model memory.

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

Canonical detail lives in `GLOSSARY.md`, ADR-0001 through ADR-0011, Wayfinder #1, and spec #8.

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

Verified on 2026-10-06 against live GitHub state; main is `e885e1c84460b2af6c7aeceac156314645febba1`:

- #9 health endpoint: closed/completed.
- #10 register + verify email: closed/completed.
- #11 sign in/current User: closed/completed; PR #43 squash-merged.
- #12 password recovery: closed/completed. PR #46 was accepted on exact HEAD `6e3430d8a924d6b271c0aaa2463f9f167e7d9cd2` after Standards, Spec, repository gates, and exact-HEAD CI all passed, then ChatGPT performed the final squash merge with expected-head protection. Main commit: `588d7e653daf00c7c9e209cc6295f7843c56b359`.
- #13 production auth email: closed/completed. PR #53 passed Standards, Spec, repository gates, and exact-HEAD CI on `364bc5afddb93bdbfd4aedf6dd7b2c9b63228943`; ChatGPT performed the final squash merge with expected-head protection. Main commit: `66cc6fe85f12dae516d7226abb5867acce0ed823`.
- #14 sandbox promotion: closed/completed. Canonical target is sandbox, not staging.
- #78 client-aware deployer/target registry, #104 required-secret declarations, and #106 rejection of plaintext required-secret bindings: closed/completed. Their isolation and secret-binding contracts govern provisioning.
- #82 Actions noise/trusted-handoff CI provenance: closed/completed. PR #109 squash-merged as main commit `1244fd71885acea3fff4a274deda8e7e78a683cd`; main CI `37332657770`, sandbox `37332657707`, Pages `37332655536` — all SUCCESS.
- #80 unified target provisioning: closed/completed. PR #110 squash-merged as main commit `350d38f946f62353e735f3fca1f86f39a782efa3`; main CI `37332977075`, sandbox `37332976990`, Pages `37332975575` — all SUCCESS. No live provisioning was performed or authorized.
- #111 Matt skills v1.3/glossary migration: closed/completed. PR #112 squash-merged as main commit `48f7fecbb31680f9d9d1b188ee974c8e27eea28f`; main CI `37333302162`, sandbox `37333302192`, Pages `37333300942` — all SUCCESS. It preserves glossary content, updates all consumers and three skill hashes, and records the tagged upstream comparison in [the audit](../research/matt-skills-v1.3-audit.md).
- Integration-only PR #113 closed without merging; CI `37316405798` passed 142 Workers + 643 harness tests at combined tree `3685d7f1eaa376588909ae5133ac754b6bdd12e3`.
- #114 complete local Matt skill dependencies and reconcile post-merge checkpoint: closed/completed. PR #115 squash-merged as main commit `e885e1c84460b2af6c7aeceac156314645febba1`.
- #116 spec (record attributable skill-tool evidence for remote agent runs): open parent specification; not for direct implementation.
- #117 implementation (persist attributable skill evidence across remote workers and reconcile checkpoint): current work. Single approved slice of #116; no previous ticket reopened.

GitHub-only skill-usage audit (25 worker runs: 16 fix-cycle + 9 ticket executions; 19 runs belong to #82; not productivity comparisons) is recorded separately from unavailable ChatGPT conversation data — no ChatGPT session dataset exists and none is inferred. Observed skill-tool minima: implement 17, code-review 13, tdd 10, custom better-typescript 5.

Current execution frontier:

```text
#117 attributable skill evidence + reconciled checkpoint
  -> configured dual review + exact-HEAD CI
  -> final acceptance
```

Merges #109/#110/#112/#115 are complete on main. No stale unresolved dependency frontier remains. Reconcile any new finding or moved HEAD against live GitHub. Final merge and live infrastructure operations retain their separate controls. Exact-HEAD CI for the #117 branch is pending PR publication and review.

## Remote execution/review gate

Durable accepted tooling:

- #31 event-driven status/watchdogs: closed.
- #36 least-privilege trusted workflow-file publication: closed.
- #40 complete notification-first run status: closed.
- #44 narrow trusted exact-HEAD CI approval for eligible agent-created PRs: closed.
- #47 action-required CI recovery: closed; PR #46 subsequently reached READY through run `34722805060` on its preserved exact HEAD.
- #37 Node-24-native GitHub Actions upgrade: closed/completed. The #36 trusted-publication artifact was published byte-for-byte, PR #50 passed correction/gates/Standards/Spec/exact-HEAD CI on `f2d6533e03e1d16310e7a92e7ac0dbc11b76a46d`, and ChatGPT performed the final squash merge with expected-head protection. Main commit: `5e71c8b9f36a8a140916a9ec5f90719253b71204`.
- #51 deterministic remote agent Git identity: closed/completed. `npm run agent:ticket` now relies on the npm `preagent:ticket` lifecycle hook to configure `github-actions[bot]` through repository-local `git config --local` only when `GITHUB_ACTIONS=true`; local developer identity is untouched and no extra GitHub permission or credential is introduced. PR #52 was merged before the successful #13 rerun; main commit: `7a5ae51cc0d4607eca62f43f7848bd5c766731ab`.

Review/execution invariants:

- Standards and Spec are independent axes.
- review markers are exact-HEAD; stale markers never satisfy a new HEAD.
- corrections rerun both axes.
- repository gates plus exact-HEAD CI are required before READY.
- `agent:ticket` remote commits depend on the repository-owned `preagent:ticket` Git-identity preflight documented in `docs/agents/opencode.md`; it must remain GitHub-Actions-only and `git config --local`.
- safe-push is deterministic repo code; model-run agents do not get generic push.
- `.github/workflows/**` corrections stop at the #36 trusted-publication handoff unless a separately authorized trusted operator publishes the verified artifact.
- agent/workflow execution never self-merges, deploys, or mutates secrets.
- final merge by ChatGPT is allowed only after final acceptance, with the expected HEAD supplied to the GitHub merge operation so a moved PR fails closed.

### Current orchestration state

The [bounded startup diagnosis](https://github.com/JonatanGarbuyo/user-service-platform/pull/109#issuecomment-5944424053) is historical. The maintainer approved the Standards model recovery in [source-ticket decision5952117927](https://github.com/JonatanGarbuyo/user-service-platform/issues/82#issuecomment-5952117927). Main commit `9cc8e30d0d5ac002d0b5a82d2ff9863b1bc56d88` adopts only the independently reviewed and exact-HEAD-CI-tested operational configuration, matching marker identity, provenance instructions and regression fixtures. Read live reviewer configuration rather than copying model assignments from this checkpoint.

The former Standards startup and trusted-approval blockers are resolved and merged on main through PR #109. The temporary runner probes were removed in main commit `3ed03977cce66bdd4029f7eddc93b0fa8d138440`; the agent workflows reinstall dependencies deterministically (`npm ci`) before quality gates, so no dependency-restoration blocker remains. The extra Standards-looking report emitted by Spec in run `36954225501` has an invalidated marker and remains informational. Every configured reviewer must publish only its own axis; legacy model identities never satisfy the recovered configuration.

#114 (local Matt skill dependencies) and #115 (its publication) are closed/completed on main at `e885e1c84460b2af6c7aeceac156314645febba1`. The 25-GitHub-run skill-usage audit is complete and recorded in the Product frontier section above; no ChatGPT conversation dataset exists and none is inferred. Current work is #117 (single approved slice of parent spec #116) on its ticket branch and PR: run the configured review cycle on the published HEAD, preserve independent reviewer identities and exact-HEAD evidence, and reconcile any new finding or moved HEAD against live GitHub.

## Maintenance debt

- #38 `Audit deprecated transitive dependencies and npm security findings`: closed/completed.
- The current open ticket inventory is #116 (parent spec) and #117 (its single approved implementation slice); issues #80, #82, #111 and #114 are closed and PRs #109, #110, #112 and #115 are merged. Query GitHub before selecting new work.
- #114 vendored the missing local `grilling` and `codebase-design` dependencies identified by the v1.3 audit. Retro/pr adoption and an implement-spec integration workflow remain follow-up decisions, not part of this maintenance task.

## Maintaining this checkpoint

Update this file when product frontier, execution/review workflow, environment terminology, final-operator authority, or a cross-session blocker changes materially. Do not duplicate volatile model assignments or full ADR/spec/ticket bodies here.
