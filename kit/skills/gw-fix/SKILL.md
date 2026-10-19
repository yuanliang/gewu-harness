---
name: gw-fix
description: The way to fix a bug - first a test that fails with the same symptom the user saw (red), committed and frozen, then the code change that makes it pass (green), without touching the test. Use when the user reports a bug, an error, a regression, or "X stopped working".
argument-hint: "<bug description>"
---

# gw-fix — reproduce first, then fix

Bug: $ARGUMENTS

> If a test fails, fix the code, not the test.

1. `.harness/gw new "<bug title>" --type bug` (or `.harness/gw use <id>` for an existing item).
2. In intent.md, record the symptom (the exact error), steps to reproduce, the expected behavior, and who is affected. A bug needs only the intent gate.
3. **Locate it read-only:** logs, code, `git log -p`, `git blame`. Form a root-cause hypothesis, and **don't fix anything yet**.
4. `.harness/gw start B1 "<expected behavior>" --check "<targeted check>" --expect "<the symptom the user saw>"`
5. Write a test that fails with **the same symptom the user saw**, then `.harness/gw red`.
   - It won't reproduce (`E_NOT_RED`): your hypothesis is wrong. Go back to step 3; do not fix by guessing.
   - It fails differently (`E_WRONG_REASON`): you reproduced a different problem.
   - A test that already fails with this symptom ("CI is red") *is* the check. Don't edit it; adopt it: `.harness/gw red --adopt <test file> --expect "<symptom>"`.
6. Fix the code (the test is frozen), then `.harness/gw green`. The full suite guards against regressions.
7. `.harness/gw done`.
8. Ask once: where else could the same defect live? If anywhere, open more cycles (B2, B3…). If an agent has made this mistake twice, add the correction to the project's agent instructions (CLAUDE.md or AGENTS.md).
