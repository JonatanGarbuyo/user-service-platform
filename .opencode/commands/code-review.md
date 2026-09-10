---
description: Adversarially review the current implementation branch against a fixed point using Matt Pocock's code-review skill
agent: reviewer
---

Read `AGENTS.md` and `docs/agents/opencode.md`, then load Matt Pocock's `code-review` skill.

Review the current branch against the fixed point supplied in `$ARGUMENTS` using the skill's three-dot merge-base comparison. If no fixed point is supplied, ask for one rather than guessing.

Identify the originating implementation ticket from commit messages, branch context, or explicit references, then read that ticket, its parent spec, `CONTEXT.md`, and all relevant ADRs.

Run both review axes required by the skill:

1. Standards — repository standards plus the skill's smell baseline.
2. Spec — completeness, correctness, and scope against the originating ticket/spec.

Do not modify code. Report actionable findings with evidence and severity/impact where useful. If an axis has no findings, say so explicitly.
