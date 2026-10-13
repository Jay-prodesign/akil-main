# APP-BILL-001 — Billing Reference Floor (OS V2 floor slice)

## Provenance

- Governing authority: canonical Handoff **REV215** (AA-005, 2026-10-11). Immediate trigger: Brain's reconciliation comment on PR #145 (id `6152530150`), step 4: "the blueprint also explicitly allows billing/subscription/credit flows to be implemented/tested in sandbox/internal mode for V2 readiness, so live billing-provider activation is a protected gate but provider-neutral billing truth/reference engineering is not automatically blocked."
- Canonical OS blueprint (Drive `1SsxLDjARcmv9QG04UWjUoCNl3QLsfm_vOrj7yQxgXWg`), §"V2 — EXTERNAL COMMERCIAL RELEASE / GA" lists "billing provider/payment/invoice reference handling" as its own separate bullet, distinct from "customer-facing usage/quota/credit and upgrade/downgrade/suspend/cancel flows" (already closed by `APP-SUB-001`/`APP-SUB-002`). This bullet had never been addressed by any prior checkpoint.
- Branch: `claude/app-bill-001-billing-reference-floor`, cut from `origin/claude/app-sub-001-entitlement-core-v2` (PR #140's branch tip) — stacked, since this checkpoint's sole non-type-only dependency (`Subscription`) is `APP-SUB-001`'s own type.

## Design decision: no monetary amount field anywhere

- Two existing modules in this repository each already explicitly declared this exact restraint, independently: `commercial-order.ts`'s `CommercialOrder` ("No price, discount, payout, or commission field exists on this type - this repository has no real commerce/payment/pricing-policy integration"), and `execution-economics-attribution.ts` ("Deliberately does not touch customer billing, payment/invoice/charge state, quotes/prices").
- This same session's own `APP-SUB-002` F1 finding (Brain PR #147 comment `6152530150`'s sibling comment `6152522225`) proved exactly what goes wrong when an adjacent module's own already-bounded amount/usage type is reused outside its declared domain — `execution-quota-admission.ts`'s `QuotaReadModel` was projected as customer commercial usage, which that module's own doc comment explicitly disclaims. Reusing `execution-economics-attribution.ts`'s `CostAmount` here would repeat the identical mistake one checkpoint later in the same session. It is therefore explicitly NOT reused — this module carries no amount field, reusing nothing from that domain.

## Scope (this checkpoint)

- `src/domain/billing-reference.ts` (new): `BillingReferenceStatus` (`"ISSUED" | "PAID" | "FAILED"` — `"ISSUED"` is the only non-terminal status); `BillingReferenceRecord` (`tenantId`/`customerId`/`subscriptionId`/`externalInvoiceRef`/`status`/`recordedAt`/`evidenceRef` — no amount field); `BillingReferenceRegistry.recordOrAdvance` (the only construction/mutation path, mirroring `ExternalSubscriptionPlanMappingRegistry`'s own admission discipline from `subscription-entitlement.ts`): fails closed if an `externalInvoiceRef` is already bound to a DIFFERENT subscription (an external invoice can never be claimed by two different subscriptions — a cross-customer billing leak); fails closed if an already-terminal (`PAID`/`FAILED`) reference is asked to transition to a different status (no resurrection, no silent overwrite); re-recording the identical status for an already-known reference is a safe idempotent no-op.
- `externalInvoiceRef`-shaped identifiers are opaque, caller-supplied strings only, mirroring `storefrontRef`/`externalSubscriptionContractRef`'s own discipline in `subscription-entitlement.ts`. No field anywhere can hold a card number, payment-method token, or gateway credential. No real billing provider is named, configured, or called.
- `tests/billing-reference.test.ts` (8 tests): B1 (new record, no amount field present — asserted structurally via `"amount" in record === false`); B2 (unresolved reference → `undefined`, never a guess); B3 (ISSUED → PAID transition, new evidence recorded); B4 (idempotent re-record of identical status is a safe no-op); B5 (adversarial — cross-subscription collision on the same `externalInvoiceRef` rejected fail-closed); B6 (adversarial — terminal-status immutability, PAID cannot transition to FAILED); B7 (adversarial — empty `externalInvoiceRef` rejected); B8 (boundary scan — imports only `tenant-scope.js`/`customer.js`/`subscription-entitlement.js`, explicitly no `execution-economics-attribution.ts`/`execution-quota-admission.ts` coupling).
- Guard-disable sanity performed on both fail-closed guards: disabling the cross-subscription check made exactly B5 fail; disabling the terminal-status-immutability check made exactly B6 fail. Both reverted and reconfirmed green.
- Full regression: **2718/2718 passing** (2710 pre-existing on PR #140's branch tip + 8 new), clean strict typecheck, zero new runtime dependency.

## Explicitly deferred (not fabricated)

- **No monetary amount anywhere.** See "Design decision" above.
- **No real billing provider.** No provider name, credential, webhook signature verification, or live payment/charge call exists anywhere in this module.
- **No HTTP route, admin UI, or wiring into any live surface.** Domain contract only, matching every prior floor-slice checkpoint's own scope discipline.
- **No durable persistence.** `BillingReferenceRegistry` is an in-memory registry, mirroring `ExternalSubscriptionPlanMappingRegistry`'s own established pattern; a durable store is a separate, later integration step.

## Architecture / semantic invariants (verified by test)

- An external invoice reference can never be claimed by two different subscriptions, even across tenants (B5).
- A terminal billing status (`PAID`/`FAILED`) is immutable once reached — no resurrection, no silent overwrite to a different terminal status (B6).
- Re-recording an identical status is always a safe no-op, never a duplicate or conflicting record (B4).
- No field anywhere on `BillingReferenceRecord` can hold a monetary amount, card number, or credential (B1, B8).
- Both guards independently confirmed load-bearing via guard-disable sanity, then restored.

## Hard Non-Scope

No modification to `subscription-entitlement.ts`, `tenant-scope.ts`, `customer.ts`, `commercial-order.ts`, `commercial-authority.ts`, or `execution-economics-attribution.ts` — all consumed unmodified or not at all. No new runtime dependency. No route/application-boundary wiring. No real billing provider, credential, or live payment/charge effect.

## Stacked-branch disclosure

This branch is cut from PR #140's branch tip, not from `main`, since its sole non-type-only dependency (`Subscription` from `subscription-entitlement.ts`) does not exist on `main` yet. This PR's range carries PR #140's full diff; it needs PR #140 merged (or this branch rebased onto `main` after it merges) before it can itself be merged.

## Evidence

- `npx tsc -p tsconfig.json` (clean `dist/` rebuild): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2718/2718 passing** (2710 pre-existing on PR #140's branch tip + 8 new).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/billing-reference.ts` (new), `tests/billing-reference.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — stacked on PR #140's range; merge requires PR #140 merged first, plus its own separately-granted protected owner-gate, never inferred from any other PR's grant. Risk classification: LOW, pure/dark-internal — this module remains unreferenced by any other `src/` file; no live platform install/config, credentials, payment, invoice issuance, tax/provider effect, or MAIN mutation.
