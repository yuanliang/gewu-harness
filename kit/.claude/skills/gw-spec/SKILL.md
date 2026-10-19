---
name: gw-spec
description: SDLC stage 2, Design. Expands an approved intent.md into spec.md, where every requirement has a Given/When/Then check and a verification level, risks are flagged for the user, and open questions are carried forward. Use after the intent is approved and before planning.
---

# /gw-spec — requirements and design

Input: `intent.md` (should be accepted) · Artifact: `spec.md` (template: `.harness/templates/<language>/spec.md`) · Gate: `! .harness/gw approve spec`

1. `.harness/gw status`, then read intent.md. If it isn't accepted yet, say so (with `gates: warn` you may continue; note it at the top of the spec).
2. Read the relevant code and conventions: the project's CLAUDE.md and similar existing features.
3. Expand every acceptance signal S# into one or more requirements R#. Each needs:
   - **Behavior:** one sentence the user can observe
   - **Check:** Given / When / Then, with concrete inputs and outputs
   - **Level:** unit, integration, e2e, or manual (say who looks and at what)
   - **From:** the S# it serves

   A requirement without a check is not a requirement: add one, or move it to open questions.
4. Non-functional requirements need a measurable threshold and a check that can go red.
5. Flag risks (security, privacy, compatibility, data) and name who decides. Don't decide policy for them.
6. Design only as much as planning needs: data, interfaces, key flows, trade-offs. No implementation.
7. Fill in traceability: every S# is covered by at least one R#.
8. Show the spec and ask the user to approve it: `! .harness/gw approve spec`.

Next: `/gw-plan`.
