---
id: <work-id>
intent: ./intent.md
status: draft
author: <name>
---

# Spec · <title>

## Context

<!-- One paragraph: the problem from intent.md and the parts of the current system that matter. -->

## Requirements and checks

<!--
A requirement without a check is not a requirement. Each R# becomes one or more red → green cycles.
Level: unit | integration | e2e | manual (say who looks, and at what).
-->

| R# | Behavior the user can observe | Given / When / Then | Level | From |
|---|---|---|---|---|
| R1 | | Given … When … Then … | unit | S1 |

## Non-functional requirements

<!-- Measurable, with a check that can go red. Example: p95 < 200 ms; the bench script exits non-zero above it. -->

## Design

<!-- Just enough to plan from: data, interfaces, key flows and trade-offs. No implementation. -->

## Risks and decisions for the user

<!-- Security, privacy, compatibility, data. Name who decides; do not decide policy for them. -->

## Traceability

| Signal | Requirements |
|---|---|
| S1 | R1 |
