# ENG-ORCH-001 — Engineering Agent Orchestration Bridge

- **Task ID:** ENG-ORCH-001
- **Project:** AKILTA (repository: `Jay-prodesign/akil-main`)
- **Goal:** Implement and prove the narrow, durable, event-driven Claude/Brain Engineering Orchestration Bridge — fencing/idempotent event replay, WAITING → ANSWER → RESUME durable wait/resume semantics, and DEC-138 provenance — with a reviewer role that remains provider-agnostic. No Codex dispatch is permitted pre-V1 (DEC-142).
- **Status:** Brain **VERIFIED / COMPLETED** at `a804ebe73822883122f3dfabd869a4651f94dd38` (round 3). No longer the current engineering cursor.
- **Governing authority:** DEC-139 (Engineering Agent Orchestration Bridge), DEC-138 (durable handoff provenance), DEC-142 (pre-V1 Codex suspension). AKI-BE-001 satisfied as dependency.
- **Branch:** `claude/ENG-ORCH-001-task-packet` (this local history shows it as a linear continuation from the AKI-BE-001 checkpoint).
- **Canonical task packet:** "AKILTA — Engineering Agent Orchestration Bridge — ENG-ORCH-001 First Bounded Implementation Candidate — 2026-08-18" / Drive `18QHU7e94tM9Bhdor50HXFPp5H8b5AaXX1BKE2cgOFIA`.

## Scope (Minimum Domain Objects)

- `EngineeringEventEnvelope` / `EngineeringEventType` / `EngineeringRole` (`src/domain/engineering-event-envelope.ts`) — the bounded event vocabulary (CHECKPOINT, BEGIN_VERIFICATION, FLAG_REVIEW, RESOLVE, ASK_QUESTION, ANSWER, OWNER_GATE, OWNER_GATE_CLEARED, TIMEOUT, RECONCILIATION_REQUIRED, RECONCILED, COMPLETE), carrying idempotency key, attempt, lease/fencing token, and DEC-138 provenance on every event.
- `EngineeringRunState` / `applyEvent` / `reconstructState` / `projectLifecyclePhases` (`src/domain/engineering-run-state.ts`) — the pure reducer: fencing-floor authority (stale writer rejection), exactly-once WAITING/RESUME_AUTHORIZED semantics regardless of append order, terminal-state (`COMPLETED`) non-regression, and a purely-derived lifecycle-phase projection over the same durable log.
- `DurableEngineeringStore` / `FileDurableEngineeringStore` (`src/domain/durable-engineering-store.ts`) — append-only, file-backed (`node:fs` only, no new dependency) durable event log; `getState` always reconstructs from the full log, proving restart-safety by construction.
- `WorkerInvoker` / `invokeSafely` (`src/domain/worker-invoker.ts`) — translates a thrown/rejected invoker outcome into an explicit, bounded, retryable `TEMPORARY_FAILURE`, never an unhandled rejection or a silent no-op.
- `Dec138Provenance` (`src/domain/dec-138-provenance.ts`) — attribution/provenance fields required on every durable event.

## Verification history

- **Round 1** (`46a3bff`) — first bounded implementation. Brain result: **CHANGES_REQUIRED — Implementation Contract Gaps** (Drive `1Eb9upW9o--1_d9-G8MgMtoQshXSKAObh31CiHsiu_NE`). Engineer evidence: `1vNtaNzdFvjjJ3NMIqDOs8h5o1UPtHYYJ7KkTnQa9FoE` (DEC-138 evidence bundle) / `1zQJgj3Cge70Db1hmIez-Ga52cL6AZxc9` + `1jifrhvuw01riLdNQ4F9CU3kKaiQibX6f` (transferable verification bundles).
- **Round 2** (`e211087`) — bounded corrections for E3/E7/E10/E12/QUESTION-ANSWER_RECEIVED representability. Correction evidence: `1QTSkN6VesPC3vBFRmmdTgf1hwjJ4hGPN`. Brain result: **CHANGES_REQUIRED** again (`ENG-ORCH-001 — Brain Re-Verification Result — CHANGES_REQUIRED — e211087 — 2026-08-19` / Drive `1VUaWetsP3n2jOEjqPH_Kihg4kQ9Eetw7mvK7UHyNLj4`).
- **Round 3** (`a804ebe`) — final corrections: E7 pre-state fencing-floor authority (a higher fencing token observed before any `EngineeringRunState` exists must still be honored on replay — see `reconstructState`'s `observedFencingFloor` handling) and E10 durable retryable-failure persistence/reconstruction across restart. Correction evidence: `ENG-ORCH-001 — Round-3 Correction Evidence Bundle — a804ebe — 2026-08-19` / Drive `1cUYGEEBbO2ZIf__GUSuFEVRRaPliZIgf`. Brain result: **PASS — VERIFIED / COMPLETED** (`ENG-ORCH-001 — Brain Verification Result — PASS — a804ebe — 2026-08-19` / Drive `16zH_3p29AFffB5m_OrEXwk3ohQs0kEgOy2bFXMPA9pY`).

## Status

Brain **VERIFIED / COMPLETED** at `a804ebe73822883122f3dfabd869a4651f94dd38`. Not reopened absent contradictory material evidence. Its durable-store architecture (append-only JSONL, full-log-replay `getState`) was reused as an established pattern — not copied vocabulary — by the DEL-003 second bounded slice's `durable-plan-admission-store.ts` and `durable-outcome-job-store.ts`.

## Note on this record

This file was created retroactively during the DEC-144 V1 Fast Lane Stage B documentation-coherence pass (2026-08-20), reconstructed from source code (`src/domain/engineering-*.ts`, `durable-engineering-store.ts`, `worker-invoker.ts`, `dec-138-provenance.ts`), `git log`, and the canonical Drive verification records cited above — not from a session-by-session checkpoint narrative (no such narrative was captured in this repository's `docs/exec-plans/` at the time the work was done). Round-by-round intermediate implementation detail beyond what is cited above is not reconstructed here to avoid inventing history not actually on record; the Drive evidence bundles cited are the authoritative detailed record.
