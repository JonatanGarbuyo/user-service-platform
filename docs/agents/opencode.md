# OpenCode implementation workflow

Use OpenCode as an implementation harness. Product/architecture decisions remain in `CONTEXT.md`, ADRs, Wayfinder/spec issues, and approved implementation tickets.

## Bootstrap

The Matt Pocock skills are committed project-locally under `.agents/skills/`. OpenCode discovers them automatically.

Connect OpenCode Zen locally with `/connect`, then verify the configured models appear in `/models`.

The repository defines two dedicated agents:

```text
implementer -> opencode/muse-spark-1.3-contributor-free
reviewer    -> opencode/nemotron-3-ultra-free
```

`/implement` is wired to `implementer`. `/code-review` is wired to `reviewer`. Planning and final acceptance are intentionally not forced onto either implementation model.

## Model data boundary

The free models used by these agents are third-party/limited-time models provided through OpenCode Zen. Treat their execution environment as untrusted for secrets and production/customer data.

- Never expose production credentials, API keys, customer data, `.env` files, or `.dev.vars` to either agent.
- Do not rely solely on OpenCode permission rules as a secret boundary when an agent has shell access.
- Unattended runs must use a clean worktree/container/account with no production credentials available in the workspace, environment, shell profile, credential stores, or Cloudflare tooling.
- Repository code is expected to be safe to share with these agents; secrets and customer data are not.

## Source of truth

Before implementation or review, read:

1. `AGENTS.md`.
2. `CONTEXT.md`.
3. The implementation ticket in full, including comments.
4. Its parent spec.
5. Relevant ADRs referenced by the ticket/spec.

Do not treat a chat transcript or generated handoff as stronger authority than these artifacts.

## Ticket execution

- Implement only approved implementation tickets carrying `ready-for-agent` semantics.
- Never run `implement` directly against a Wayfinder map or broad parent spec.
- Work one ticket per fresh context.
- Work only the dependency frontier: all blockers must already be complete.
- Prefer one ticket = one isolated branch/worktree. Parallel agents must not share a working tree.
- Follow the ticket's highest agreed test seam and use TDD where required by the `implement` workflow.
- A green formatter/linter is not sufficient; every acceptance criterion must be verified.

## Adversarial review gate

Every implementation ticket must receive an independent review after the implementer finishes and before the ticket is accepted/closed.

The reviewer is deliberately a different model family from the implementer and is read-only. It follows Matt Pocock's `code-review` skill, which evaluates the branch on two independent axes:

1. **Standards** — repository rules, architecture conventions, and the skill's smell baseline.
2. **Spec** — missing/incorrect requirements and scope creep against the implementation ticket and parent spec.

For a ticket branch based on `main`, run:

```text
/code-review main
```

The reviewer must not edit the implementation. Findings go back to the implementer or a human for resolution. After corrections, rerun the review from a fresh reviewer context. A ticket is ready for final acceptance only when material findings are resolved or explicitly dispositioned.

## Decision boundary

Implementation agents may choose local implementation details that do not alter public contracts or accepted architecture.

Stop and report instead of inventing a decision when work would require any of the following:

- changing a public API contract or error semantics;
- changing an accepted ADR;
- adding a new infrastructure dependency or external provider;
- weakening authentication/security policy;
- changing data ownership between feature slices;
- changing deployment/production behavior;
- expanding product scope beyond the ticket.

Such changes return to planning/Wayfinder before implementation continues.

## Unattended execution safety

The `implementer` agent has repository-local guardrails denying obvious production-impacting operations such as pushes, deployments, secret mutation, package publishing, PR merges, and destructive infrastructure commands. These are defense in depth, not a sandbox.

The `reviewer` agent is read-only: it may inspect diffs/history and run non-mutating verification commands, but it cannot edit, commit, merge, deploy, publish, or mutate infrastructure.

Agents may commit on their isolated implementation ticket branch only through the implementer. Publishing and deployment remain deliberate human actions.

## Current implementation frontier

The parent specification is GitHub issue #8: `Spec: Foundation and verified-email identity walking skeleton`.

Approved implementation tickets are #9 through #14. Blocking edges are recorded in each ticket.

The current dependency frontier contains only:

- #9 `Serve a contract-tested Worker health endpoint`

Implementation + review sequence:

```text
/implement JonatanGarbuyo/user-service-platform#9
/code-review main
```

Do not start #10 or later tickets until all of their listed blockers are complete, independently reviewed, and accepted. After each implementation ticket, use a fresh context for both implementation and adversarial review.
