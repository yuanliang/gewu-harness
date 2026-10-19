---
name: gw-build
description: SDLC stages 3-4, Build and Test. Executes plan.md one red-green cycle at a time - start, write the failing test, prove red, smallest implementation, prove green, refactor, done. Use to implement an approved plan or to continue an open cycle.
argument-hint: "[C# or R#, optional]"
---

# /gw-build — run the red → green cycles

Input: `plan.md` (should be approved) · Target: $ARGUMENTS

Hooks enforce the phase locks: in TEST only tests are writable, and tests freeze at red. When something is blocked, take the path the message names; never look for another way around.

## One cycle

1. **Open:** `.harness/gw start <R#> "<behavior>" --check "<targeted check>" --expect "<predicted failure>"`
2. **Write the check** (TEST: only tests are writable)
   - Assert observable behavior, not implementation details. Never mock the unit under test.
   - For an independent view, delegate this step to the `gw-test-author` subagent, so the test isn't written to fit the code you are about to write.
3. **Prove red:** `.harness/gw red`
   - `E_NOT_RED`: the test doesn't catch the missing behavior. Strengthen the assertion, or check whether the behavior already exists.
   - `E_WRONG_REASON`: it failed for a reason you didn't predict. Find out why first. Fix the test; change the prediction (`--expect`) only when the prediction itself was wrong, and say why.
   - `E_BROKEN_CHECK`: the check command could not run. Fix the command; that is never red.
   - On success the tests freeze 🔒 and a `[red]` commit records them.
4. **Make it pass** (RED: only source is writable). Write the **smallest** change, then `.harness/gw green`.
   - `E_NOT_GREEN`: change the code, not the test.
   - `E_REGRESSION`: the targeted check passes but the full suite fails. Fix the regression.
   - The test itself is wrong: `.harness/gw reopen "<why>"` and go back to step 2.
5. **Refactor** (GREEN: tests stay frozen): remove duplication, improve names, match the surrounding code.
6. **Close:** `.harness/gw done` re-verifies, writes evidence.md and makes the `[green]` commit.
7. If you departed from plan.md, add a row to its deviations before `done`. It is committed with the cycle.

## Several cycles

- Follow plan.md in order. After each cycle report one line, for example: `C2 ✅ R1 6th attempt returns 429 · red exit 1 → green`.
- Independent cycles can run in parallel in separate git worktrees; each worktree keeps its own gw state.
- After three failed attempts at the same step, stop and give the user your hypotheses and options.
- When all cycles are done, run `.harness/gw audit` and suggest `/gw-review`.
