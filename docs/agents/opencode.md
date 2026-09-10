# OpenCode implementation workflow

Use OpenCode as an implementation harness. Product/architecture decisions remain in `CONTEXT.md`, ADRs, Wayfinder/spec issues, and approved implementation tickets.

## Bootstrap

The Matt Pocock skills are committed project-locally under `.agents/skills/`. OpenCode discovers them automatically.

Connect OpenCode Zen locally with `/connect`, then verify the configured models appear in `/models`.

The repository defines three dedicated agents:

```text
implementer          -> opencode/muse-spark-1.3-contributor-free
reviewer-standards   -> opencode/mimo-v2.5-free
reviewer-spec        -> opencode/nemotron-3-ultra-free
```

`/implement` is wired to `implementer`. `/review-standards` and `/review-spec` run as subagents so both review axes have independent context and different model families.

## Model data boundary

The free models used by these agents are third-party/limited-time models provided through OpenCode Zen. Treat their execution environment as untrusted for secrets and production/customer data.

- Never expose production credentials, API keys, customer data, `.env` files, or `.dev.vars` to these agents.
- Do not rely solely on OpenCode permission rules as a secret boundary when an agent has shell access.
- Unattended runs must use a clean worktree/container/account with no production credentials available in the workspace, environment, shell profile, credential stores, or Cloudflare tooling.

## Source of truth

Before implementation or review, read:

1. `AGENTS.md`.
2. `CONTEXT.md`.
3. The implementation ticket in full, including comments.
4. Its parent spec.
5. Relevant ADRs referenced by the ticket/spec.

A chat transcript is not stronger authority than these artifacts.

## Ticket execution

- Implement only approved `ready-for-agent` tickets from the dependency frontier.
- Never run `implement` directly against a Wayfinder map or broad parent spec.
- Work one ticket per fresh context and isolated branch/worktree.
- Follow the ticket's highest agreed test seam and use TDD where required.
- A green formatter/linter is not sufficient; every acceptance criterion must be verified.

## Pull request as the review handoff

After local implementation is complete, push the ticket branch and open a draft pull request before adversarial review. The pull request is the durable handoff between implementation, automated/model review, and final human/ChatGPT acceptance.

The PR should reference the implementation ticket and parent spec. Review findings belong on the PR rather than being copied into chat or posted to the implementation issue.

## Dual adversarial review gate

Every implementation ticket must pass two independent read-only reviews before final acceptance:

1. **Standards — MiMo-V2.5 Free**: repository rules, architecture conventions, maintainability, and Matt Pocock's smell baseline.
2. **Spec — Nemotron 3 Ultra Free**: missing/incorrect requirements and scope creep against the implementation ticket and parent spec.

From the implementation branch with an open PR, run:

```text
/review-standards
/review-spec
```

Optionally pass a PR number or URL when reviewing something other than the current branch's PR.

Each reviewer resolves the PR base as its fixed point and publishes one top-level PR comment through GitHub CLI. Every report includes its axis/model and the exact reviewed HEAD SHA so stale reviews are visible after subsequent commits.

The findings remain separate; do not let one axis cancel or rerank the other. Material findings go back to the implementer or human reviewer. After corrections, rerun both reviews from fresh contexts and publish new SHA-stamped reports.

Final acceptance can then inspect the PR diff, CI and both review comments directly from GitHub; no manual copy/paste into chat is required.

## Decision boundary

Implementation agents may choose local details that do not alter public contracts or accepted architecture. Stop and report rather than inventing a decision when work would require changing a public contract, accepted ADR, infrastructure/provider choice, security policy, feature data ownership, deployment behavior, or product scope.

## Unattended execution safety

The implementer may commit locally on its isolated ticket branch but may not deploy, publish, merge, mutate production infrastructure, or change secrets. Publishing the implementation branch and opening a draft PR are deliberate developer/harness operations. Both review agents are otherwise read-only; their only GitHub write permission is publishing their review report as a PR comment.

## Current implementation frontier

The parent specification is GitHub issue #8: `Spec: Foundation and verified-email identity walking skeleton`.

Approved implementation tickets are #9 through #14. The current frontier contains only #9: `Serve a contract-tested Worker health endpoint`.

Current sequence:

```text
/implement JonatanGarbuyo/user-service-platform#9
# push branch + open draft PR
/review-standards
/review-spec
# final acceptance reads PR + CI + both comments
```

Do not start #10 until #9 is implemented, both review axes have completed, material findings are resolved, and final acceptance is complete.
