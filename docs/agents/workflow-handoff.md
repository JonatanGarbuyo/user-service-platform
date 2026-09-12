# Trusted publication handoff for workflow-file corrections

Ticket #36 policy. Remote agent corrections may legitimately modify
`.github/workflows/**`, but the ordinary Actions `GITHUB_TOKEN` cannot create
or update workflow files, and model/OpenCode processes must never receive a
broad workflow-write credential. Product-ticket automation keeps the existing
least-privilege token boundary: none of the repository workflows grant
`workflows: write`.

## Handoff instead of privilege

1. Agent/correction work may edit workflow files locally and run the
   deterministic quality gates.
2. Before an ordinary push, repository-owned code detects changes under
   `.github/workflows/**` over the exact known commit range.
3. Ordinary remote automation does not attempt the doomed generic push and
   does not gain more privilege. It stops with a `BLOCKED` state whose reason
   carries the `trusted-publication-required` marker, which is deliberately
   distinct from ordinary safe-push validation failures (wrong branch, PR
   head/base mismatch, dirty worktree, push to `main`).
4. The blocked run persists the correction as a patch plus exact base/head
   metadata and publishes the explicit `BLOCKED` / trusted-publication-required
   status through the normal durable status surface (with owner attention
   mention, like other `BLOCKED` states).
5. A trusted human or separately authorized ChatGPT GitHub operation publishes
   the reviewed workflow change.
6. Normal exact-HEAD dual review and CI resume after publication: rerun
   `review:cycle` (or `/agent-fix-cycle`) so both review axes report against
   the newly published exact HEAD.

A fully automated privileged publisher is not required now. A later dedicated
publisher may be considered only if it runs from trusted repository code, uses
a narrowly scoped credential not exposed to the model process, and has an
explicit approval boundary.

## Detection points

Detection lives in deterministic repository-owned TypeScript, tested at the
Node seam, never in model-authored logic:

- `scripts/review/workflow-handoff.ts` — path matching, range-diff/patch
  command builders, handoff record format, and bundle persistence.
- `scripts/agent/ticket-flow.ts` — the initial ticket-branch push is refused
  when the range from `origin/main` at start through the implementation HEAD
  touches workflow files.
- `scripts/review-cycle.ts` — both the start `push-and-refresh` path and the
  post-`address-review` correction push are refused when their exact ranges
  touch workflow files.
- `.github/workflows/agent-fix-cycle.yml` — a guard step before the direct
  safe-push refuses when the range from the validated PR HEAD through the
  correction HEAD touches workflow files.

## Evidence bundle

A blocked handoff leaves, under `.agent-ticket/`:

- `workflow-handoff.patch` — the workflow-file diff for the exact range.
- `workflow-handoff.json` — version, branch, exact base/head SHAs, touched
  files, patch path, and the `trusted-publication-required` reason.

Remote workflows upload this bundle as run artifacts alongside
`.review-cycle/latest.json` (and `.agent-ticket/outcome.json` for
`agent-ticket` runs), so the trusted publisher never reconstructs work from
runner logs. The terminal status comment carries the marker, the touched
files, and the action required.

## Trusted publication procedure

1. Download the handoff bundle from the blocked run's artifacts.
2. Review the patch and the exact base/head metadata.
3. Publish the reviewed workflow change to the ticket branch through a trusted
   operation (human push or separately authorized connector operation).
4. Rerun review on the published HEAD so Standards, Spec, and CI evidence is
   stamped against the exact commit under review.
