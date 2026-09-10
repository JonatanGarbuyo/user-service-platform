---
description: Run the Standards axis of Matt Pocock code review against a fixed point
agent: reviewer-standards
subagent: true
---

Read `AGENTS.md`, `CONTEXT.md`, `docs/agents/opencode.md`, relevant ADRs, and Matt Pocock's `code-review` skill.

Use `$ARGUMENTS` as the fixed point. Confirm it resolves and review `git diff $ARGUMENTS...HEAD` plus the corresponding commit list.

Run only the Standards axis: documented repository standards plus the skill's smell baseline. Report concrete findings with file/hunk evidence. Do not modify code.
