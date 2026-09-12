---
description: Run the Spec axis of project code review and publish it to the current pull request
agent: reviewer-spec
subagent: true
---

Read `AGENTS.md`, `CONTEXT.md`, `docs/agents/opencode.md`, the originating implementation ticket and comments, its parent spec, relevant ADRs, and the repository-pinned `code-review` skill.

Resolve the pull request from `$ARGUMENTS` when supplied; otherwise resolve the pull request for the current branch with `gh pr view`. Determine its base branch and use the corresponding local or remote-tracking base ref as the fixed point. Confirm the fixed point resolves, record the current HEAD SHA, and review the three-dot diff plus commit list required by the skill.

Run only the Spec axis: missing or partial requirements, incorrect implementation, contradictions, and scope creep. Reference the exact ticket/spec requirement for each finding. Do not modify code.

Publish the final report as a top-level comment on that pull request via `gh pr comment`. Begin with `## Spec review — DeepSeek V4 Flash Free` and include `Reviewed HEAD: <sha>`. End the comment with exactly one machine-readable marker line so deterministic orchestration never infers pass/fail from prose:

`<!-- review-result: axis=spec model=deepseek-v4-flash-free head=<sha> result=PASS|FAIL|NEEDS-DECISION -->`

Use `PASS` when there are no blocking findings for the reviewed HEAD, `FAIL` when valid blocking findings require an in-scope code correction, and `NEEDS-DECISION` when a finding requires a product, architecture, public-contract, infrastructure-provider, or security-policy decision. The `head` must be the exact reviewed HEAD SHA. If publication fails, preserve the complete report in your response and report the publication error.
