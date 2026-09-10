---
description: Run the Spec axis of Matt Pocock code review against a fixed point
agent: reviewer-spec
subagent: true
---

Read `AGENTS.md`, `CONTEXT.md`, `docs/agents/opencode.md`, the originating implementation ticket and comments, its parent spec, relevant ADRs, and Matt Pocock's `code-review` skill.

Use `$ARGUMENTS` as the fixed point. Confirm it resolves and review `git diff $ARGUMENTS...HEAD` plus the corresponding commit list.

Run only the Spec axis: missing or partial requirements, incorrect implementation, contradictions, and scope creep. Reference the exact ticket/spec requirement for each finding. Do not modify code.
