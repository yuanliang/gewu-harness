---
name: gw-incident
description: SDLC stage 6, Maintain. An incident or alert becomes facts, then a failing test that reproduces it (red), then a fix, then a lesson in docs/lessons.md, and if needed a new intent that closes the loop back to Plan. Use for production incidents, alerts, metric breaches and severe user reports.
argument-hint: "<incident description or alert link>"
---

# /gw-incident — incident → reproduction → lesson → new intent

Incident: $ARGUMENTS

> Detection stays deterministic (monitors, thresholds, alerts). Claude is called in after the breach.

1. **Collect facts:** timeline, symptoms, impact, relevant metrics and logs. Keep facts and guesses apart.
2. `.harness/gw new "<incident title>" --type incident`. In intent.md: what happened, the impact, the behavior to restore, and acceptance signals that prove the same incident cannot happen the same way again.
3. **Red first:** `.harness/gw start I1 "<behavior that must hold>" --expect "<incident symptom>"`, write the reproducing test, then `.harness/gw red`. If you cannot reproduce it, keep investigating; don't fix blind.
4. Fix it through normal cycles (see "One cycle" in `/gw-build`).
5. Append a post-mortem to `docs/lessons.md`: timeline, root cause, **why existing checks didn't catch it**, the new check, and follow-ups.
6. When the same mistake happens a second time, add the correction to the project's CLAUDE.md.
7. **Close the loop:** if a larger change is needed, write a new intent (type feature) and go back to Plan.
