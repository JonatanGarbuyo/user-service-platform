# OpenCode permission rationale

OpenCode agents should minimize approval noise without treating permission patterns as a security sandbox.

## Repository path rule

Start OpenCode at the active worktree root and use repository-relative paths for all in-worktree file tools. Absolute paths for repository files are unnecessary and can trigger external-directory classification in some OpenCode versions/path-normalization cases.

## Project policy

- `external_directory`: deny by default.
- `edit`: allow for the implementation agent; deny for reviewers.
- routine repository inspection and deterministic quality-gate shell commands: allow.
- local staging/committing: allow for the implementation agent.
- uncommon shell commands: ask.
- push, merge, deployment, publishing, secret mutation and destructive infrastructure commands: deny.

`--auto` is appropriate only for isolated low-risk/unattended environments: it removes approval interruptions for `ask` operations while preserving explicit `deny` rules.

## Security boundary

Shell permission patterns are convenience/defense-in-depth controls, not a complete sandbox. Equivalent effects can sometimes be reached through interpreters or scripts that do not match a command deny pattern. Unattended agents therefore run without production credentials, customer data, `.env`, `.dev.vars`, production Cloudflare authorization, or other sensitive host resources.

If stronger unattended isolation is required, run OpenCode inside a disposable container/VM with only the ticket worktree mounted and only the minimum network/credentials required for that ticket.
