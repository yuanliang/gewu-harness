---
name: gw-review
description: SDLC stage 5, Deploy (review). Audits the evidence with gw audit, then has the independent gw-reviewer subagent review the branch against REVIEW.md, looking above all for false greens, and reports ranked findings. Use when all cycles are done, before opening a PR.
argument-hint: "[base branch, default main]"
---

# gw-review — audit the evidence, then review independently

Base: $ARGUMENTS (if empty, try `origin/main`, then `main`, then `master`)

1. `.harness/gw status` must be IDLE.
2. `.harness/gw audit --base <base> --replay`. Fix any problem before reviewing.
3. Get an independent review with a fresh context: in Claude Code, run the `gw-reviewer` subagent; with other agents, start a new session or subagent and give it these instructions. Give it the base and the work item directories (`docs/work/<id>/`), and have it review `git diff <base>...HEAD` against `REVIEW.md`, looking above all for the false greens it lists.
4. Report its findings ranked blocker → major → minor → nit, one per line: `[level] file:line — problem. Why it matters. Suggestion.`
5. Fix what you can the gw way: behavior problems in new cycles, pure formatting in a chore. Then audit again.
6. Tell the user plainly: **findings neither approve nor block the PR; merging needs a code owner's approval.**

Next: `gw-ship`.
