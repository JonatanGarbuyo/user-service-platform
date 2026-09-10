# OpenCode implementation workflow

Use OpenCode as an implementation harness. Product/architecture decisions remain in `CONTEXT.md`, ADRs, Wayfinder/spec issues, and approved implementation tickets.

## Bootstrap

Install the Matt Pocock skills project-locally for OpenCode:

```bash
npx skills@latest add mattpocock/skills \
  --agent opencode \
  --skill setup-matt-pocock-skills \
  --skill wayfinder \
  --skill to-spec \
  --skill to-tickets \
  --skill implement \
  --skill tdd \
  --skill code-review \
  --skill handoff \
  -y
```

OpenCode discovers project skills from `.agents/skills/`. Commit the installed skill files/lock metadata so every implementation agent uses the same workflow version.

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

For unattended runs, use OpenCode permission rules rather than unrestricted shell access. At minimum deny production-impacting operations such as `git push`, Worker deployment, secret mutation, and destructive infrastructure commands. Agents may commit on their isolated local ticket branch, but publishing/deploying remains a deliberate human action.

## Current execution entry point

The current parent specification is GitHub issue #8: `Spec: Foundation and verified-email identity walking skeleton`.

Run `to-tickets` against #8 and obtain human approval of ticket granularity/blocking edges before publishing them. Once published, execute the first unblocked implementation ticket with `implement`.
