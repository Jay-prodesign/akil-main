# CUS-OFFBOARD-002 — Customer Offboarding Execution Lifecycle (OS V2 floor slice, continuation)

## Provenance

- Governing authority: canonical Handoff **REV215** (AA-005, 2026-10-11). Immediate trigger: Brain's independent reconciliation comment on PR #145 (id `6152530150`, "BRAIN RECONCILIATION — V2 IS NOT EXHAUSTED"), which rejected Claude's own prior-turn exhaustion conclusion and gave an exact next sequence: (1) correct PR #147's F1 domain conflation, (2) reconcile PR #148 after that correction, (3) continue with `CUS-OFFBOARD-002` from `CUS-OFFBOARD-001`'s own explicitly-deferred cross-module delete/export/retention gap, (4) fresh-scan again. Steps 1–2 were completed in this session's immediately prior turn (see `APP-SUB-002.md`'s and `V2-FLOOR-INT-001.md`'s own "Brain review correction" sections). This checkpoint is step 3.
- `CUS-OFFBOARD-001` (PR #149) explicitly disclosed, in its own exec-plan's "Explicitly deferred" section, that it closes only the request/decision record and a scope-limited export snapshot of the customer's own public fields — it does **not** perform or drive any actual cross-module delete/export/anonymization effect, and does not enumerate what customer-scoped resources even exist. Brain's reconciliation names this as the genuine remaining gap, not an invented one.
- Branch: `claude/cus-offboard-002-execution-lifecycle`, cut from `origin/claude/cus-offboard-001-lifecycle-request` (PR #149's branch tip) — stacked, since this checkpoint's sole non-type-only dependency (`CustomerOffboardingRequest`) is `CUS-OFFBOARD-001`'s own type, mirroring this corridor's established `APP-SUB-001`→`APP-SUB-002` stacking precedent.

## Resource inventory (verified before designing, not assumed)

- Direct grep against current `main` confirmed exactly three `src/domain` types carry a `customerId` field: `project.ts`'s `Project`, `customer-evidence.ts`'s `CustomerEvidenceItem`, `commercial-order.ts`'s `CommercialOrder`.
- Direct grep for `export function delete|redact|purge|export` across `src/domain` found exactly one hit — `organization-lifecycle-archive.ts`'s export/restore pair — which is **Organization**-scoped (`OS-V1-04`), not Customer-scoped. None of `project.ts`/`customer-evidence.ts`/`commercial-order.ts` exports anything beyond its own `create*` constructor.
- Conclusion, stated honestly rather than invented: there is currently no real delete, export, or anonymization capability anywhere in this repository for any customer-scoped resource. A "lifecycle enforcement package" built today cannot itself purge or export real data — it can only truthfully record that fact, durably and idempotently, per resource kind.

## Scope (this checkpoint)

- `src/domain/customer-offboarding-execution.ts` (new): `CustomerScopedResourceKind` (closed union: `"PROJECT" | "CUSTOMER_EVIDENCE" | "COMMERCIAL_ORDER"`, exactly the verified inventory above); `CustomerResourceDispositionStatus` (single reachable literal `"BLOCKED_UNSUPPORTED"`, mirroring `commercial-authority.ts`'s own `CommissionLedgerStatus` restraint — widened only when a real capability is introduced for a specific kind); `CustomerOffboardingExecutionState` (`tenantId`/`customerId`/`offboardingRequestId`/`status: "NOT_STARTED" | "COMPLETED"`/`resourceDispositions`); `startCustomerOffboardingExecution` (the only construction path, fails closed unless the given `CustomerOffboardingRequest.status === "COMPLETED"` — never bypasses or re-derives `CUS-OFFBOARD-001`'s own decision gate); `advanceCustomerOffboardingExecution` (produces one `BLOCKED_UNSUPPORTED` disposition per inventoried resource kind, each carrying the caller-supplied `evidenceRef`; idempotent/restart-safe — applied to an already-`COMPLETED` state it is an exact no-op, returning the unchanged original state even when a replay supplies a *different* `evidenceRef`, so a crashed-and-retried execution can never silently acquire a second, differently-evidenced disposition set for the same request).
- `tests/customer-offboarding-execution.test.ts` (7 tests): E1 (happy path — `NOT_STARTED` with empty dispositions from a `COMPLETED` request); E2/E3 (adversarial — cannot start from a merely-`REQUESTED` or `DENIED` request); E4 (advancing produces exactly 3 truthful `BLOCKED_UNSUPPORTED` dispositions, one per real resource kind, each carrying the supplied `evidenceRef`); E5 (idempotency/restart-safety — replaying advance on an already-`COMPLETED` state with a *different* `evidenceRef` is an exact no-op, original evidence trail preserved); E6 (adversarial — empty `evidenceRef` rejected); B1 (boundary scan — imports only `tenant-scope.js`/`customer.js`/`customer-offboarding.js`, explicitly no live import of `project.ts`/`customer-evidence.ts`/`commercial-order.ts` themselves — the resource-kind inventory is a closed string-literal list, not a live dependency on those modules).
- Guard-disable sanity performed on both fail-closed/idempotency checks: disabling the `COMPLETED`-only start guard made exactly E2/E3 fail; disabling the idempotent-no-op check made exactly E5 fail. Both reverted and reconfirmed green.
- Full regression: **2683/2683 passing** (2676 pre-existing on PR #149's branch tip + 7 new), clean strict typecheck, zero new runtime dependency.

## Explicitly deferred (not fabricated)

- **No actual delete/export/anonymization effect against any customer-scoped resource.** Every disposition this checkpoint can produce is honestly `BLOCKED_UNSUPPORTED` — see "Resource inventory" above for why. When a real capability is later introduced for a specific resource kind (e.g. a genuine `deleteProject`/`exportProjectSnapshot` primitive), this module's own `CustomerResourceDispositionStatus` union is the place to widen, for that kind only — never fabricated ahead of the real primitive existing.
- **No guessed retention period.** No field anywhere in this module could hold one.
- **No live-customer effect, no HTTP route, no admin UI.** Domain contract only, matching every prior floor-slice checkpoint's own scope discipline.
- **No durable persistence/store.** `CustomerOffboardingExecutionState` is a pure in-memory value, mirroring `CUS-OFFBOARD-001`'s own request/decision records; a durable store for this state (so a real crash-and-restart can actually resume from disk rather than only being proven idempotent in-process) is a separate, later integration step — explicitly not fabricated as already wired here.

## Architecture / semantic invariants (verified by test)

- Execution can never start from a request that hasn't passed through `CUS-OFFBOARD-001`'s own `completeCustomerOffboarding` decision gate (E2–E3).
- Every resource disposition this checkpoint can produce is the single truthful `BLOCKED_UNSUPPORTED` literal — never a fabricated delete/export success (E4).
- A completed execution's disposition set and evidence trail are immutable under replay — advancing twice can never silently replace or duplicate the original evidence (E5).
- Both guards independently confirmed load-bearing via guard-disable sanity, then restored.

## Hard Non-Scope

No modification to `customer-offboarding.ts`, `customer.ts`, `tenant-scope.ts`, `project.ts`, `customer-evidence.ts`, `commercial-order.ts`, `authority.ts`, or `organization-membership.ts` — all consumed unmodified or not at all. No new runtime dependency. No route/application-boundary wiring. No real data-deletion sweep.

## Stacked-branch disclosure

This branch is cut from PR #149's branch tip, not from `main`, since this checkpoint's sole non-type-only dependency (`CustomerOffboardingRequest` from `customer-offboarding.ts`) is `CUS-OFFBOARD-001`'s own type. This PR's range therefore carries PR #149's full diff; it needs PR #149 merged (or this branch rebased onto `main` after it merges) before it can itself be merged.

## Evidence

- `npx tsc -p tsconfig.json` (clean `dist/` rebuild from scratch): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2683/2683 passing** (2676 pre-existing on PR #149's branch tip + 7 new).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/customer-offboarding-execution.ts` (new), `tests/customer-offboarding-execution.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — stacked on PR #149's range; merge requires PR #149 merged first, plus its own separately-granted protected owner-gate, never inferred from any other PR's grant. Risk classification: LOW, pure/dark-internal — no live platform install/config, credentials, payment, actual data deletion, or MAIN mutation. Per Brain's own reconciliation, V2 is not treated as exhausted by this checkpoint's completion — the next action is a fresh current-main + canonical-blueprint dependency scan (see CURRENT_STATE.md), not a stop.
