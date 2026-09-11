# SALE-TO-CLOSE — External Sale/Order-to-OutcomeJob E2E Acceptance Floor

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor; CONN-001 (Integration & Credential Control Plane) Brain Handoff addendum — Rev91/92 added a "SALE-TO-CLOSE E2E acceptance floor" requirement on top of the merged/in-review CONN-001 slices: "accept a VERIFIED external commerce/order fact through the admitted integration boundary; idempotently/deterministically bootstrap or reconcile the AKILTA Project + SoldScope + OutcomeJob; preserve tenant isolation; survive duplicate delivery, replay and crash; cancellation/refund/chargeback facts must update/stop/escalate internal work consistently, but AKILTA must not itself become the payment/settlement/refund engine."
- **Selection reasoning**: this is a distinct mission from CONN-001 itself. CONN-001 (PR #38) builds the connector/credential control plane (catalog, durable connection store, admin read-model, generic + prebuilt connector adapters) — it never touches `OutcomeJob`/`Project`/`SoldScope` at all. SALE-TO-CLOSE is the next-layer floor: given an already-admitted, `VERIFIED` `ConnectionBinding` (CONN-001's own output) vouching that an external sale fact occurred, deterministically drive AKILTA's existing execution/verification domain (`outcome-job.ts`, `project.ts`, `sold-scope.ts`) to a governed outcome — without inventing a second workflow/state system and without modifying any existing merged/in-review file.
- Per explicit self-instruction from the prior checkpoint: opened as its **own new branch/PR**, not stacked onto PR #38 — CONN-001's own scope is complete at slice 5, and SALE-TO-CLOSE composes on top of it rather than extending it.
- Branch: `claude/sale-to-close-e2e-floor`, cut fresh from `main`.
- `BASE_PROVENANCE_SHA`: `3226c76fa338e425e553638e5f5f48924182a1c0` (merged main).

## Goal

Given a caller-supplied, already-`VERIFIED` `ConnectionBinding` vouching for an external sale/order fact, deterministically and idempotently bootstrap (or safely no-op replay) the corresponding `Project` + `SoldScope` + `OutcomeJob`, and provide a governed way to record a cancellation/refund/chargeback disposition against the resulting `OutcomeJob` — all while reusing every existing domain construction/lifecycle function completely unmodified.

## Scope (this checkpoint)

- `src/domain/external-sale-bootstrap.ts`:
  - `bootstrapExternalSaleOutcome(input)` — pure function. Fail-closed cross-tenant check (`connection.ownership.tenantId` must equal the caller's `tenantScope.tenantId`) and fail-closed connection-state check (`connection.connectionState` must be `VERIFIED` — `REQUESTED`/`CONNECTED_UNVERIFIED`/`DEGRADED`/`REVOKED`/`HANDOVER_COMPLETE` all reject). Also rejects a `customer` that does not belong to the given `tenantScope`. All three identifiers (`Project.projectId`, `SoldScope.soldScopeId`, `OutcomeJob.jobId`) are **deterministically derived from the caller-supplied `externalSaleRef` alone** (`sale-project:${externalSaleRef}`, `sale-scope:${externalSaleRef}`, `sale-job:${externalSaleRef}`) — the same idempotency primitive `outcome-job-wiring.ts` already established for `jobId` (derived from `spec.specId`, never freshly generated). Delegates construction verbatim to the existing, unmodified `createProject`/`createSoldScope`/`createOutcomeJob`.
  - `applyExternalSaleDisposition(input)` — validates `kind` is one of `CANCELLATION`/`REFUND`/`CHARGEBACK`, then delegates to `outcome-job.ts`'s own existing, unmodified `enterExceptionState` (`to: "STOPPED"`), preserving the disposition kind and `externalSaleRef` verbatim in the resulting `AuditEvent`'s `reason` text.
- `src/domain/durable-external-sale-bootstrap-store.ts`:
  - `FileDurableExternalSaleBootstrapStore` — mirrors `durable-outcome-job-store.ts`'s own already-established `putIfAbsent`-only idempotency pattern (one JSON-lines file per tenant under `baseDir`, keyed by `externalSaleRef`). `putIfAbsent` is the sole write path — a duplicate delivery or crash-replay of the same `externalSaleRef` can never create a second durable record; it reports `created: false` and returns the exact result first persisted. Fails closed if a caller attempts to claim an already-persisted `externalSaleRef` with a materially different bootstrapped result (different `jobId`/`projectId`/`soldScopeId`).

## Explicitly deferred (not invented)

- **No new workflow/state system**: this module invents no Project/SoldScope/OutcomeJob construction or lifecycle logic of its own — every object is produced by calling the existing, unmodified `createProject`/`createSoldScope`/`createOutcomeJob`/`enterExceptionState` exactly as any other caller in this repository already does.
- **No payment/settlement engine**: `bootstrapExternalSaleOutcome` never computes price, tax, currency, settlement, or payout, and `applyExternalSaleDisposition` never reverses a charge or issues a refund — it only records the already-governed fact against the `OutcomeJob`. This preserves CONN-001's own disclosed "commerce ownership boundary": settlement stays the provider's/AI Commerce's domain, never AKILTA's.
- **No fabricated exception-state exit/recovery graph**: `outcome-job.ts` itself documents, as a genuine, disclosed, pre-existing limitation, that `BLOCKED`/`RECOVERING`/`ESCALATED`/`STOPPED` have only entry implemented, with no specified exit/recovery transition graph. `applyExternalSaleDisposition` reuses `enterExceptionState` exactly as-is and does not invent a way out of `STOPPED` — a `STOPPED` job cannot be un-stopped by anything in this checkpoint, matching the canonical source's own silence on that question.
- **No bootstrap via the full blueprint-compilation/plan-admission pipeline**: `compilePlan`/`admitPlan`/`admitJobs` require blueprint and readiness-assertions data a raw external sale event does not carry. Bootstrapping `Project`+`SoldScope`+`OutcomeJob` directly (as this checkpoint does) is the honest reading of "idempotently/deterministically bootstrap... the AKILTA Project + SoldScope + OutcomeJob" for a sale that arrives as an opaque external fact, not a blueprint-driven plan.
- **No queue/webhook transport, no HTTP handler**: this checkpoint is the domain/persistence boundary only — how an external sale/order webhook actually reaches this function (CONN-001's own connector surface, or a future adapter) is out of scope here, matching CONN-001's own progressive-elaboration discipline of not building speculative transport plumbing ahead of an actual caller.

## Architecture / semantic invariants (verified by test)

- Replaying `bootstrapExternalSaleOutcome` with the same `externalSaleRef` and the same well-formed input produces a **byte-for-byte identical** result — a pure, deterministic function with no freshly-generated id anywhere in it.
- A `ConnectionBinding` bound to a different tenant can never vouch for a sale bootstrapped under another tenant's `tenantScope`, even if the caller supplies a mismatched `tenantScope` by mistake or by malicious cross-tenant injection.
- A `ConnectionBinding` that is not `VERIFIED` (never verified, revoked, or degraded) can never vouch for an external sale fact, regardless of how plausible the supplied sale data looks.
- A `Customer` that does not belong to the given `tenantScope` is rejected before any object is constructed.
- `applyExternalSaleDisposition` accepts only `CANCELLATION`/`REFUND`/`CHARGEBACK`; the disposition kind and `externalSaleRef` are preserved verbatim in the resulting `AuditEvent.reason` — never blurred into a generic label.
- The full sale-to-close happy path can only reach `CLOSED` after a `PASSED` `VerificationResult` — a `FAILED` verification, or bare execution success, can never close the loop (proven by chaining the existing, unmodified `transitionOutcomeJob`/`verifyOutcomeJob`).
- `FileDurableExternalSaleBootstrapStore.putIfAbsent` persists a new bootstrapped result exactly once; a duplicate sale/order event delivered twice, or a crash-then-replay against a fresh store instance over the same durable directory, converges to exactly one persisted record with no in-memory index to diverge from disk.
- Durable records are strictly tenant-isolated: the same `externalSaleRef` string under two different tenants is stored and retrieved as two fully independent records.

## Hard Non-Scope

No modification to any existing merged/in-review file (`outcome-job.ts`, `project.ts`, `sold-scope.ts`, `connection-authority.ts` are all read-only dependencies here); no payment/settlement/refund computation; no HTTP/webhook transport; no new runtime dependency beyond Node's built-in `node:fs`; no fabricated exception-state recovery graph; no cross-tenant data leakage in either the bootstrap function or the durable store.

## Test Coverage

| Test | Acceptance direction | Covered in |
|---|---|---|
| Deterministic Project+SoldScope+OutcomeJob construction from externalSaleRef | idempotent/deterministic bootstrap | `tests/external-sale-bootstrap.test.ts` R1 |
| Byte-for-byte identical replay of the same externalSaleRef | pure function, no freshly-generated id | R2 |
| Cross-tenant connection injection fails closed | tenant isolation | R3 |
| REVOKED connection fails closed | only a VERIFIED connection can vouch for a sale fact | R4 |
| Never-verified (REQUESTED) connection fails closed | same as above | R5 |
| Cross-tenant customer fails closed | tenant isolation | R6 |
| Unrecognized disposition kind rejected | fail-closed input validation | R7 |
| CANCELLATION/REFUND/CHARGEBACK yield explicit governed STOPPED disposition with disposition-specific audit reason | consistent stop/escalate, no blurred label | R8 |
| A CLOSED job cannot receive a disposition | reuses outcome-job.ts's own precondition, no fabricated exit graph | R9 |
| Full happy path reaches CLOSED only via a PASSED VerificationResult; FAILED verification and bare execution success cannot close the job | verification failure cannot reach CLOSED / execution success is not verification | R10 |
| putIfAbsent persists a bootstrapped result exactly once; replay is a no-op | durable idempotency | `tests/durable-external-sale-bootstrap-store.test.ts` S1 |
| Duplicate sale/order event delivery produces no duplicate project/job | at-least-once delivery survives | S2 |
| Crash-then-replay converges to exactly one persisted record across a fresh store instance | restart/crash recovery | S3 |
| Conflicting bootstrapped result under an already-persisted externalSaleRef fails closed | durable record integrity | S4 |
| Durable records are tenant-isolated even under a shared externalSaleRef string | no cross-tenant data leakage | S5 |

## Evidence

- `npm run build` (`tsc -p tsconfig.json`, strict mode incl. `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`): exit 0, zero errors.
- `npm run test`: **723/723 pass**, 0 fail, 0 skipped (708 pre-existing baseline + 15 new: R1-R10 in `external-sale-bootstrap.test.ts`, S1-S5 in `durable-external-sale-bootstrap-store.test.ts`).
- `package.json`: zero new runtime or dev dependency (`durable-external-sale-bootstrap-store.ts` uses only Node's built-in `node:fs`/`node:path`, matching `durable-outcome-job-store.ts`'s own boundary).
- Files touched: `src/domain/external-sale-bootstrap.ts` (new), `src/domain/durable-external-sale-bootstrap-store.ts` (new), `tests/external-sale-bootstrap.test.ts` (new), `tests/durable-external-sale-bootstrap-store.test.ts` (new), `package.json` (clean-script fix, same pattern applied on every branch this session), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant.
