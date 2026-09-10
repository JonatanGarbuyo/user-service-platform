# OpenCode implementation workflow

Use OpenCode as an implementation harness. Product/architecture decisions remain in `CONTEXT.md`, ADRs, Wayfinder/spec issues, and approved implementation tickets.

## Bootstrap

The Matt Pocock skills are committed project-locally under `.agents/skills/`. OpenCode discovers them automatically.

Connect OpenCode Zen locally with `/connect`, then verify the configured implementation model appears in `/models`.

The repository defines `.opencode/agents/implementer.md` as the dedicated implementation agent. It uses:

```text
opencode/muse-spark-1.3-contributor-free
```

`/implement` is wired to this agent. Planning and independent review are intentionally not forced onto the same model.

## Contributor-model data boundary

Muse Spark 1.3 Contributor Free is a Contributor model. Prompts and responses may be used to improve future models. Treat the implementation environment accordingly.

- Never expose production credentials, API keys, customer data, `.env` files, or `.dev.vars` to the agent.
- Do not rely solely on OpenCode permission rules as a secret boundary when the agent has shell access.
- Unattended runs must use a clean worktree/container/account with no production credentials available in the workspace, environment, shell profile, credential stores, or Cloudflare tooling.
- Repository code is expected to be safe to share with this implementation model; secrets are not.

## Source of truth

Before implementation, read:

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
- Run code review before considering the ticket complete.
- A green formatter/linter is not sufficient; every acceptance criterion must be verified.

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

Agents may commit on their isolated local ticket branch. Publishing and deployment remain deliberate human actions.

## Current implementation frontier

The parent specification is GitHub issue #8: `Spec: Foundation and verified-email identity walking skeleton`.

Approved implementation tickets are #9 through #14. Blocking edges are recorded in each ticket.

The current dependency frontier contains only:

- #9 `Serve a contract-tested Worker health endpoint`

Run:

```text
/implement JonatanGarbuyo/user-service-platform#9
```

Do not start #10 or later tickets until all of their listed blockers are complete and reviewed. After each implementation ticket, use a fresh context for the next frontier ticket.
