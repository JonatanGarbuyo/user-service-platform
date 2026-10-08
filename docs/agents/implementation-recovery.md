# Implementation recovery evidence after worker timeout/failure

Ticket #127 policy. Two `/implement` executions for the administrator UI
reached the unchanged 30-minute bound with no published ticket branch or PR,
and the existing uploaded evidence preserved outcome/skill records but not
the unpublished partial source changes. A retry therefore reran
implementation blindly. This record closes that execution gap without
changing product scope, timeout bounds, or publication safeguards.

## What is captured

When the `agent-ticket` implement worker times out or fails, repository-owned
code captures a best-effort bounded secret-safe recovery record **after** the
worker promise has settled and process-group termination has been signalled
(SIGTERM, SIGKILL after the kill grace; a worker still terminating during that
grace window may still race the snapshot) and embeds
it additively in the already-uploaded `.agent-ticket/outcome.json` artifact.
No workflow-file edit or new credential is needed: the existing
`agent-ticket` artifact selection already uploads that outcome record.

The record carries the actual failed-worktree state, never the start HEAD
presented as proof of no progress:

- original base SHA, actual local HEAD, ticket branch;
- bounded counts (committed, uncommitted, untracked, included, excluded);
- explicit completeness/truncation/unavailability metadata;
- one bounded combined patch for eligible tracked changes since the base
  (local commits plus uncommitted tracked edits/deletions);
- bounded full contents for eligible untracked source files;
- safe worker-lifecycle diagnostics (allowlisted event/tool names, counts,
  timestamps, last-known status only);
- workflow-file metadata (paths only) when the failed worktree touches
  `.github/workflows/**`, pointing back to the trusted-publication handoff
  policy instead of carrying workflow patch content.

Capture performs read-only Git/filesystem operations only. It never stages,
commits, resets, cleans, pushes, opens a PR, merges, or deploys. Its failure
keeps honest incomplete/unavailable metadata and never replaces the original
`TIMEOUT`/`BLOCKED` result. Console and issue-status surfaces expose only a
fixed safe summary (presence, completeness, counts); source patch content
stays in the uploaded outcome record.

## What is deliberately omitted

Eligibility is path-based through an explicit allowlist
(`scripts/review/implementation-recovery.ts`): source, test, docs, migration,
and non-secret build-config roots plus named top-level config files. The
following never enter recovery artifacts, diagnostics, or console output:

- nested `.env`/`.env.*` and `.dev.vars`/`.dev.vars.*` variants;
- logs, local D1/SQLite state, build outputs, `node_modules`, runtime
  data, exports/transcripts, and other secret-bearing runtime files;
- credential/key file extensions (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`);
- symlinks (never followed) and any path outside the worktree;
- workflow-file patch content (metadata only; the trusted-publication
  boundary in `docs/agents/workflow-handoff.md` still applies);
- raw prompts, reasoning, text events, tool inputs/outputs, HTTP payloads,
  shell command strings, recipient addresses, credential values, and
  session/verification tokens.

## Operator recovery procedure (recovery, not a blind rerun)

A `TIMEOUT`/`BLOCKED` implement outcome with recovery evidence is not a
diagnosis of an application defect and does not claim the underlying ticket
work is fixed. It only preserves real partial progress for operator-driven
reuse:

1. Download `.agent-ticket/outcome.json` from the failed run's artifacts and
   read the `recovery` field: check `status`, `reasons`, `counts`,
   `workflowFiles`, and the `truncated`/`patchTruncated`/
   `untrackedTruncated` flags.
2. If `workflowFiles` is non-empty, follow the trusted-publication handoff
   policy first; do not publish workflow changes through ordinary automation.
3. On a fresh isolated worktree checked out at the recorded `base` (never on
   a dirty or unreviewed branch), save `recovery.combinedPatch` to a file and
   run `git apply --check` followed by `git apply`; then create each
   `recovery.untrackedFiles` entry at its recorded `path` with its recorded
   `content`.
4. Treat truncated/incomplete records as partial: missing material was
   deliberately bounded out and must be re-authored, not assumed present.
5. Run the repository quality gates on the recovered worktree and continue
   through the normal implementation/review path; recovered code is still
   unreviewed until Standards, Spec, and exact-HEAD CI pass.

Do not apply recovery output onto a dirty worktree, do not push recovered
code without review, and do not rerun `/agent-ticket` on the failed branch
expecting it to resume: the failed branch was never published, so a fresh
isolated worktree plus explicit reapplication is the only supported reuse.
