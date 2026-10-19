# Gewu Harness · verification first, red before green

This project follows the AI-native SDLC loop: **Plan → Design → Build → Test → Deploy → Maintain → Plan**.
Each stage commits an artifact the next stage reads (`docs/work/<id>/`). Humans decide at the gates; the commit chain is the audit trail.
These rules bind every coding agent here. Hooks enforce them for Claude Code, Codex and Cursor; for any agent, `gw` and CI check the evidence.

## Rules

1. **Verification first.** No behavior change without a check that was first observed failing for the reason you predicted. Write the test, run `.harness/gw red`, then implement.
2. **Red before green.** `.harness/gw green` proves it passes (targeted check and full suite). Tests freeze at red: **change the code, not the test.**
3. A wrong test is fixed through `.harness/gw reopen "<why>"`, which is recorded and needs a new red. Never route around the freeze; scripted edits are caught at green (`E_TAMPER`).
4. Non-behavioral changes (rename, formatting, dependency bump) go through `.harness/gw chore "<why>"`, which the user confirms. Closing it runs the full suite.
5. Never edit `.harness/state.json` or `evidence.*` by hand. Guardrail files (`.harness/**`, agent hook settings, `REVIEW.md`, `gw-*` skills) need the user's confirmation.
6. **You never approve.** The user approves intent, spec and plan by running `.harness/gw approve <doc>` themselves (in Claude Code: `! .harness/gw approve <doc>`); an edit after approval needs approval again. Push, PR, merge and release are the user's call: ask every time. You may act up to the production gate, never past it.
7. Write work-item documents in the user's language.

## One cycle

```
.harness/gw start <R#> "<behavior>" --check "<runs only the new test>" --expect "<predicted failure>"   → TEST: only tests are writable
.harness/gw red                                                                                       → RED: proven failing, tests frozen, [red] commit
.harness/gw green                                                                                     → GREEN: targeted check and full suite pass
.harness/gw done                                                                                      → IDLE: re-verified, evidence written, [green] commit
```

- Predict the failure before you run red. A wrong prediction means your model of the code is off; find out why.
- A crash (missing import, compile error) counts as red only when you predicted it with `--expect`.
- Without `--check`, `start` needs the full suite green, so old failures cannot pose as new red.
- An existing failing test that already describes the behavior is adopted, not edited: `.harness/gw red --adopt <file> --expect "<its failure>"`.
- One behavior per cycle. Smallest change to green, then refactor.
- If the implementation departs from plan.md, record the deviation in plan.md within the same cycle.
- After three failed attempts at the same step, stop and tell the user your hypotheses and options.

## Stages

Each stage has a playbook skill in `.claude/skills/` and `.agents/skills/`. If your agent does not load skills, read `.agents/skills/<name>/SKILL.md` when you enter the stage.

| Stage | Skill | Artifact | Gate |
|---|---|---|---|
| Plan | `gw-intent` | intent.md with falsifiable acceptance signals | user approves |
| Design | `gw-spec` | spec.md: every requirement has a Given/When/Then check | user approves |
| Build | `gw-plan` → `gw-build` | plan.md as red → green cycles, then code and tests | user approves plan |
| Test | built into each cycle; `gw-fix` for bugs | evidence.jsonl / evidence.md | `gw audit` |
| Deploy | `gw-review` → `gw-ship` | review findings, PR | user approves each push / PR / merge |
| Maintain | `gw-incident` | failing repro test, `docs/lessons.md`, new intent | — |

Small changes scale down: a bug needs only an approved intent, and a `quick` work item needs none. Unsure what's next? Use `gw-next`. Current state: `.harness/gw status`.

When the same mistake happens twice, add the correction to the project's agent instructions (CLAUDE.md or AGENTS.md).
