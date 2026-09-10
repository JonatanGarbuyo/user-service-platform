# Automated dual-review cycle

One deterministic command runs the complete Standards + Spec review and
correction loop from a ticket branch with an open pull request:

```text
npm run review:cycle
```

The orchestrator (`scripts/review-cycle.ts`) is deterministic repository code,
not another LLM agent. It invokes the existing OpenCode commands as workers,
reads only machine-readable review markers, and never infers pass/fail from
prose.

## Prerequisites

- Work on an isolated ticket branch (for example `chore/16-review-cycle`).
- Push the branch and open a draft PR before running the cycle.
- Start from the worktree root.

## Usage

```text
npm run review:cycle
npm run review:cycle -- --max-cycles 3
npm run review:cycle -- --pr 42 --no-push
```

Options:

- `--max-cycles N` bounds correction cycles (default 3).
- `--pr <number|url>` reviews a PR other than the current branch's PR.
- `--no-push` skips the safe-push after a correction commit (pushing is on by
  default so the PR tracks the corrected HEAD).

A successful run ends with:

```text
READY FOR FINAL ACCEPTANCE
HEAD: <sha>
Standards: PASS — MiMo
Spec: PASS — Nemotron
CI/local gates: PASS
Cycles: <n>
```

## How one cycle works

1. Resolve the PR for the current ticket branch.
2. Run both axes concurrently: `/review-standards` with
   `reviewer-standards` (MiMo-V2.5) and `/review-spec` with `reviewer-spec`
   (Nemotron 3 Ultra).
3. Collect PR comments and keep only the latest machine-readable marker per
   axis for the exact current HEAD SHA. Stale markers from older HEADs are
   ignored when a newer report for that axis exists.
4. If both axes report `PASS` for the current HEAD, run the repository
   quality gates (lint, formatting, typecheck, OpenAPI drift, Workers tests,
   Node/harness tests) and finish ready for final acceptance.
5. If a valid blocking `FAIL` exists, invoke Muse through the existing
   `/address-review` workflow for the smallest in-scope correction, commit
   locally, then rerun both axes against the new HEAD.
6. Stop after the bounded number of correction cycles instead of looping
   indefinitely, and stop immediately when a finding reports `NEEDS-DECISION`.

Both axes stay independent: one axis never cancels or reranks the other, and
Muse is invoked only when blocking findings require an in-scope code
correction. Findings that need a product, architecture, public-contract,
infrastructure-provider, or security-policy decision escalate to planning
instead of changing code.

## Review markers

Each review report ends with exactly one marker line:

```text
<!-- review-result: axis=standards model=mimo-v2.5 head=<sha> result=PASS|FAIL|NEEDS-DECISION -->
<!-- review-result: axis=spec model=nemotron-3-ultra head=<sha> result=PASS|FAIL|NEEDS-DECISION -->
```

`PASS` means no blocking findings for the reviewed HEAD, `FAIL` means valid
blocking findings need correction, and `NEEDS-DECISION` escalates. The
`head` must be the exact reviewed HEAD SHA. Marker parsing and policy live
in `scripts/review/result-marker.ts` and `scripts/review/cycle-policy.ts`
with Node-seam tests under `test/node/review-*.test.ts`.

## Push safety

Models keep their explicit deny rules: no generic `git push`, no merge, no
deploy, no publishing, no secret mutation, and no destructive Cloudflare
operations. The only automated push path is the deterministic
`scripts/safe-push.ts` (also runnable as `npm run review:safe-push`), which
verifies the current branch is a ticket branch, the PR head matches it, the
base is `main`, the worktree is clean, and the push cannot target `main`.
It refuses otherwise and never merges.

## Unattended usage (OpenCode v1.18.x)

```bash
cd "$(git rev-parse --show-toplevel)"
opencode --auto
```

`--auto` auto-approves operations that would otherwise ask, while explicit
`deny` rules still apply. Unattended runs must still use an isolated
worktree/container/account with no production credentials, API keys,
customer data, `.env` files, `.dev.vars`, or production Cloudflare
authorization available. See `docs/agents/opencode.md` and
`docs/agents/opencode-permissions.md`.
