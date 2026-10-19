---
name: gw-plan
description: SDLC stage 3, Build planning. Splits an approved spec.md into an ordered list of red-green cycles in plan.md (one behavior per cycle, the test written first, the predicted failure, the smallest implementation, a targeted check) and hands it to the user for approval. Use before writing any code for a feature.
---

# /gw-plan — turn the spec into red → green cycles

Input: `spec.md` (should be approved) · Artifact: `plan.md` (template: `.harness/templates/<language>/plan.md`) · Gate: `! .harness/gw approve plan`

If you are in plan mode, iterate with the user there and write plan.md after they accept it. **No implementation code before the plan is approved.**

1. `.harness/gw status`, then read spec.md and the relevant code.
2. Choose the checks:
   - Full suite: `verify` in `.harness/config.json`
   - Targeted: for each cycle, a fast command that runs only its test (its `--check`). Run it once to confirm it is green today.
3. Split the work into cycles C1…Cn. For each:
   - exactly **one** behavior (one R#, or one slice of it)
   - the test written first: file and test name
   - the **predicted failure**: how that test fails before any implementation. This is your model of the code, and it becomes `--expect`
   - the smallest implementation, in one sentence
4. Order: the thinnest end-to-end path first, then branches, edge cases and errors. The system is green after every cycle.
5. Map every R# to at least one cycle.
6. Write down risks and how to roll back.
7. Show the plan and ask the user to approve it: `! .harness/gw approve plan`.

Next: `/gw-build`.
