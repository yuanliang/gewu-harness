---
id: <work-id>
spec: ./spec.md
status: draft
author: <name>
---

# Plan · <title>

## Checks

- Full suite: `<verify from .harness/config.json>`
- Targeted: `<command that runs only this work's tests>` (each cycle's `--check`)

## Red → green cycles

<!--
One behavior per cycle. Order: the thinnest end-to-end path first, then branches and edge cases.
"Predicted failure" is how the new test should fail before any implementation; it becomes --expect.
The system is green at the end of every cycle.
-->

| C# | R# | Test written first (file · name) | Predicted failure (--expect) | Smallest implementation |
|---|---|---|---|---|
| C1 | R1 | | | |

## Risks and rollback

## Deviations

<!-- When the implementation departs from this plan, add a row in the same cycle. -->

| When | Cycle | Deviation | Why |
|---|---|---|---|
