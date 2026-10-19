---
name: gw-next
description: Entry point of the Gewu harness. Reads the current red-green cycle state, works out where the work is in the SDLC loop, and moves it to the next step. Use when the user says "continue", "next", "keep going", describes a new goal, or is unsure which gw skill applies.
argument-hint: "[what you want, optional]"
---

# gw-next — move the loop forward

First run `.harness/gw status` to see the current state.

User's request: $ARGUMENTS

## Route

Take the first rule that matches and follow that skill (to continue an open cycle, follow "One cycle" in `gw-build`):

1. Phase is TEST, RED, GREEN or CHORE → **finish the open cycle first.** Do not start something new.
2. A bug, regression or error report → `gw-fix`
3. A production incident, alert or metric breach → `gw-incident`
4. No work item yet, or a new idea → `gw-intent`
5. The intent is still a draft → finish it and ask the user to approve it: they run `.harness/gw approve intent` (in Claude Code: `! .harness/gw approve intent`)
6. A feature without an approved spec → `gw-spec`
7. A feature without an approved plan → `gw-plan`
8. An approved plan with cycles left → `gw-build`
9. All cycles done → `gw-review`, then `gw-ship`

With `gates: warn`, an unapproved document does not stop you, but say which gate is still open.

## Report

After each step, tell the user in one or two lines: what you did, the evidence (red and green exit codes), what comes next, and which decision is theirs.
