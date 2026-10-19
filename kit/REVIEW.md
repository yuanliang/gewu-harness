# REVIEW.md — review policy

Human and Claude reviewers both follow this file. **Findings neither approve nor block a PR**; merging still needs a code owner's approval through branch protection.
Humans focus on intent and risk. Leave mechanical checks to `gw audit` and CI.

## 0. Evidence first

- [ ] `gw audit --base <base> --replay` passes: every red was re-proven at its own commit, and HEAD is green.
- [ ] Every behavior change belongs to a closed cycle; in `evidence.md` each cycle goes red (exit ≠ 0) → green (exit 0).
- [ ] Each red failed **for the right reason**: the predicted `--expect` matched, and an adopted test really describes the behavior.
- [ ] Every reopen has a good reason, not "make the test easier to pass".
- [ ] No chore hides a behavior change. Read its diff line by line.
- [ ] Changes to guardrail files (`.harness/**`, agent hook configs, `gw-*` skills and agents, this file) were confirmed by a human.

## 1. False greens

- No assertion, an assertion that is always true, or "does not throw" as the only check
- Mocking the unit under test, or asserting only that a mock was called
- Asserting implementation details instead of observable behavior
- New `skip`, `only`, `xfail` or `todo`
- A broad try/catch that swallows the failure
- Snapshots updated wholesale with no one reading the diff
- Tests that depend on time, order or network
- Special cases in the implementation that exist only for the test

## 2. Traceability

- Every R# in the spec maps to at least one cycle, and every cycle to an R#.
- Behavior no requirement asked for is scope creep: add it to the spec, or remove it.
- plan.md's deviations match what was actually built.

## 3. Correctness and risk

- Edge cases, error handling, concurrency, data migration, backward compatibility
- Security: input validation, authorization, no secrets in the diff, dependency risk
- Performance: every budgeted metric has a check that can go red

## 4. Maintainability

- Names, duplication, and consistency with the surrounding code
- The smallest change: no code for hypothetical future needs

## Severity

| Level | Meaning |
|---|---|
| **blocker** | Wrong behavior, data or security risk, missing or forged evidence |
| **major** | A key check missing, a false green, clear scope creep |
| **minor** | Maintainability issues |
| **nit** | Style preference; may be ignored |

## Format

```
[level] path/to/file.ts:42 — problem. Why it matters. Suggestion.
```
