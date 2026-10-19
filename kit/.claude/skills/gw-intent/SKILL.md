---
name: gw-intent
description: SDLC stage 1, Plan. Turns an idea into intent.md with the user (problem, outcome, falsifiable acceptance signals, scope, open questions) and hands it to the user for approval. Use when the user brings a new feature, requirement or idea.
argument-hint: "<idea>"
---

# /gw-intent — capture the intent

Idea: $ARGUMENTS

Artifact: `docs/work/<id>/intent.md` · Gate: the user approves with `! .harness/gw approve intent`

1. `.harness/gw status`. Without a fitting work item: `.harness/gw new "<short title>" [--type feature|bug|incident|quick]`.
2. Read the relevant code, docs and recent commits. **Write no code in this stage.**
3. Brainstorm with the user: at most three questions per round, each with your recommended answer so they can just say yes.
4. Fill in intent.md in the user's language. **The acceptance signals are where verification starts:** each one is observable and falsifiable, and says how you would know it is not done.
   - Weak: "login is more secure"
   - Strong: "the 6th failed login from one IP within 60 s returns 429; attempts 1–5 are unaffected"
5. Anything that cannot be a signal yet goes under open questions, with who answers it. Don't pretend to be certain.
6. Before handing over, check: the problem states facts, not a solution; every signal could be disproved by a check that goes red; constraints are complete.
7. Show the intent and ask the user to approve it with `! .harness/gw approve intent`. **You cannot approve it yourself.**

Next: a feature goes to `/gw-spec`; a bug goes to `/gw-fix`.
