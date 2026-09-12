---
description: Address valid blocking findings from the current pull request review cycle
agent: implementer
---

Resolve the target pull request. If `$ARGUMENTS` is non-empty, use it as the PR number or URL; otherwise resolve the PR for the current branch with `gh pr view`.

Read the full PR conversation, current HEAD SHA, base branch, implementation ticket, parent spec, relevant ADRs, and the latest Standards, Spec, and final acceptance comments. Load the `better-typescript` skill when a correction touches TypeScript type design.

Identify only findings that are still pending for the current implementation. Respect chronology and authority:

1. A later final acceptance comment may explicitly accept, reject, or reclassify a model-review finding.
2. Do not implement findings that a later acceptance comment explicitly rejected or marked as false positives.
3. Do not silently resolve architectural, product, security-policy, infrastructure-provider, or public-contract questions. Stop and report those for planning.
4. Ignore review reports stamped for an older HEAD when a newer review of the same axis exists.

For each clearly valid pending finding that is within the ticket's accepted scope, make the smallest correction that preserves the established architecture. Use TDD when behavior changes. Apply `better-typescript` only when its trigger matches the correction; do not expand a narrow fix into speculative type-system refactoring. Do not broaden the ticket.

Use repository-relative paths for all in-worktree file operations. Never construct absolute paths for repository files. If an in-repository path is mistakenly classified as external, retry with the relative path rather than requesting external access.

After corrections, run the full relevant quality gates, including formatting, linting, type checking, OpenAPI drift checks, Workers tests, and harness tests when those scripts exist. If any gate fails, fix only issues caused by the current implementation or report unrelated baseline failures separately.

Commit the review fixes locally on the current ticket branch with a ticket-scoped commit message. Do not push, merge, deploy, publish, mutate Cloudflare resources, or change secrets.

Finish with a concise disposition table: finding, source review/comment, action taken or reason not taken, and verification performed. Remind the developer to push and rerun both adversarial review axes for the new HEAD.
