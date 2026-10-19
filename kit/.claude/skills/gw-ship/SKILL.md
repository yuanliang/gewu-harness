---
name: gw-ship
description: SDLC stage 5, Deploy (release prep). Confirms the audit and the full suite pass, writes a PR description with a traceability matrix (R# to cycle to test to red commit to green), and pushes and opens the PR only after the user agrees. Stops at the production gate. Use when review is done and the user wants a PR or release.
disable-model-invocation: true
argument-hint: "[base branch, default main]"
---

# /gw-ship — prepare the release, stop at the production gate

> The agent may act up to the production gate and never past it.

1. Preconditions, all required:
   - `.harness/gw status` is IDLE
   - `.harness/gw audit --base <base> --replay` passes
   - `.harness/gw check` passes
2. Write the PR description:
   - the intent in brief, linking intent.md, spec.md and plan.md
   - a **traceability matrix**: `R# → C# → test → red commit (sha) → green`, taken from each work item's evidence.md
   - chores and reopens, each with its reason
   - risks, rollback, and who needs to approve
3. Show the user the exact commands (`git push -u origin <branch>`, `gh pr create …`) and the description. **Run them only after the user explicitly agrees.** The harness asks for confirmation on these commands as well.
4. Do not merge and do not deploy. Tell the user that merging needs a code owner's approval and that production needs its named owner.
