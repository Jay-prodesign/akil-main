---
name: akilta-state-writeback
description: AKILTA-only bounded state writeback workflow. Use when updating Current Project State, Engineering Handoff, task records, evidence records, stop proof, or canonical Drive/repo state after a coherent mission. Prevents append-only alternative history and duplicated governance prose.
---

# AKILTA State Writeback

Use after a coherent mission, not after every microstep. This skill writes existing authority surfaces; it does not create new registries.

## Normal Bounded Writeback

Prefer only:

- `STATE_DELTA`
- `EVIDENCE_EVENT`
- `DECISION_DELTA` only when genuinely required
- `NEXT_ACTION`

## Rules

- Preserve the existing canonical artifact identity.
- Mutate the active compact selector/current task in place when that is the current authority.
- Keep provenance/history as history, not executable runtime authority.
- Do not duplicate decisions already covered by AA-002, AA-003, AA-004, AA-005, AA-011, or a current task record.
- Do not create canonical prose after each microstep.
- Use revision/head fencing and semantic readback.
- If a change cannot fit the current artifact without creating a competing runtime head, preserve evidence in the appropriate cold/provenance surface and normalize the selector.

Writeback is not permission to widen scope, promote lifecycle status, merge, publish, release, or mark visual acceptance.
