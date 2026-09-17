# APP-SUB-001 — Embedded Subscription + Entitlement Core (external-commerce-first)

## Selection proof

AA-005 Handoff Rev59 (fresh-read, `modifiedTime` independently verified to have advanced) found APP-I18N-001 (PR #91) Brain PASS/VERIFIED and, via a fresh full Roadmap + live-tree audit, classified APP-SUB-001 as the only additional deferred software capability whose trigger is now satisfied by the Founder's intended embedded-commerce subscription launch. Live PR #91 tree audit confirmed: no subscription/entitlement/payment/invoice domain module exists anywhere, and `commercial-order.ts` explicitly states no real commerce/payment/pricing integration exists yet.

## Scope

Base: PR #91 exact head `51944ba8ea35b20e90487ca21270f006898daeb3`. Branch `claude/app-sub-001-embedded-subscription-entitlement-core`, draft-targeting `claude/app-i18n-001-tr-en-portal-localization`. Risk: MEDIUM while pure/dark-internal (per Rev59's own classification); any IAM mutation or real-money/credential/customer/provider effect would be HIGH/PROTECTED and is explicitly out of scope here. Founder gate: NONE for this bounded dark/internal floor.

## Naming correction (mid-implementation, self-resolved)

The first implementation pass used the external commerce platform's real name directly in `src/domain/subscription-entitlement.ts` type/field names (per Rev59's own task text, which names it explicitly). This was found, before commit, to fail this repository's own existing, permanent constitutional guard — `tests/project-boundary-scan.test.ts`'s `T12 / RG-06` — which fails the full suite the moment any named commerce-platform string appears anywhere under `src/`, by design: its own doc comment states it exists so that "a future change [never] introduces a commerce-platform or AI Commerce dependency into src/," directly implementing `CLAUDE.md`'s "this repository is AKILTA only... no shared domain authority" boundary and `ACCEPTANCE_CRITERIA.md`'s Invariant 6.

Resolved as a reversible, architecture-within-envelope technical decision (not a scope/product change): every external-platform-named identifier was renamed to a fully provider-neutral vocabulary (`ExternalCustomerLinkage`, `storefrontRef`, `externalCustomerRef`, `externalProductOrVariantRef`, `externalSellingPlanRef`, `externalSubscriptionContractRef`, `externalFactRef`) — mirroring how `integration-connector-catalog.ts` already represents other providers as closed-enum *data* rather than hardcoded type names. The named platform becomes, at most, a runtime string *value* a caller supplies (e.g. in a future adapter layer or in tests) — never a `src/` identifier. This preserves 100% of Rev59's required behavior (a real external-commerce customer/product/selling-plan/subscription mapping, replay-safe lifecycle, role-separation) while fully satisfying the pre-existing isolation invariant; no functional requirement was narrowed or dropped. `T12 / RG-06` now passes together with every other test.

## Implementation

`src/domain/subscription-entitlement.ts`:

- **`SubscriptionPlan`** — AKILTA's own commercial-plan catalog truth, deliberately distinct from `ProjectPlanVersion` (delivery-work planning truth for one project — a genuinely different domain this repository already keeps separate).
- **`ExternalCustomerLinkageRegistry`** (`linkOnce`/`resolve`) — the only construction path binding an external platform's `(storefrontRef, externalCustomerRef)` identity to an exact AKILTA `(tenantId, customerId)`. Collision-safe `JSON.stringify` keying (this session's own established injective-encoding discipline, CXP-001K/L/R/U/V/W). Re-linking the identical tuple is a safe no-op; re-linking to a *different* tenant/customer fails closed with `AmbiguousExternalCustomerLinkageError`.
- **`ExternalSubscriptionPlanMappingRegistry`** (`admit`/`resolve`) — the only construction path binding an external `(storefrontRef, externalProductOrVariantRef, externalSellingPlanRef)` tuple to an exact `SubscriptionPlan`, requiring `admittedByAuthorityId`/`evidenceRef` (mirrors `service-catalog-admission.ts`'s single-gate, immutable-once-admitted discipline). Admitting a *different* plan for an already-admitted external tuple fails closed.
- **`Subscription`** lifecycle — `PENDING_ACTIVATION → ACTIVE → PAST_DUE → (ACTIVE | CANCELED | EXPIRED)`, plus `PAUSED`/`RESUMED`. `createPendingSubscription` derives tenant/customer/plan identity only from already-resolved, trusted linkage/mapping objects — never raw caller strings — and rejects a linkage/mapping pair spanning different storefronts or tenants. `applySubscriptionLifecycleFact` is a pure, replay-safe reducer: a duplicate `factId`, or a fact naming no legal transition from the current status, is always a safe no-op that still records the `factId` as seen, so a later replay of a fact a subsequent one has already superseded can never regress the subscription (e.g. a stale `PAYMENT_FAILED` replayed after a later `PAYMENT_RECOVERED`). `PAST_DUE` is this module's disclosed grace window — Rev59 names "pause/past-due/grace/cancel/expiry" as lifecycle dimensions to fail-closed-gate, not a mandate for a textually distinct fourth state; entitlement is revoked immediately on entering it (fail-closed default) and restored only by a verified recovery fact.
- **`Entitlement`** — a pure derivation (never separately stored/mutable state) from a subscription's current status and its exact bound plan; rejects a mismatched or foreign-tenant plan.

No import from `authority.ts` or `organization-membership.ts` anywhere in this module — an external platform's own roles/permissions have no code path into AKILTA `OrganizationRole`/membership/READ/WRITE/EXECUTE/protected-action authority through this module, structurally. No field capable of holding a card number, payment-method token, or gateway credential anywhere; every commerce reference is an opaque string (mirrors `connection-authority.ts`'s `SecretRef` discipline). No payment-gateway SDK or credential import exists anywhere in the module. No new runtime dependency.

## Tests

- `tests/subscription-entitlement.test.ts` (22 tests, S1–S22): verified activation (and its negative — no fact, no activation); trusted customer/plan mapping idempotency and collision-safety; ambiguous external identity rejection (same-tenant and cross-tenant); renewal; payment failure/past-due entitlement revocation; payment recovery restoration; cancellation/expiry terminal revocation; pause/resume; duplicate-factId replay safety; the load-bearing stale-fact-after-supersession replay-safety case; full-log reconstruction matching incremental application; tenant isolation in `deriveEntitlement`; cross-storefront rejection in `createPendingSubscription`.
- `tests/app-sub-001-boundary-scan.test.ts` (8 tests, B1–B8): structural proof of zero `authority.ts`/`organization-membership.ts` coupling; zero `OrganizationRole`/`AuthorityContext`/permission-function reference in actual code (comments stripped before scanning, since several deliberately *explain* what is excluded); zero payment-gateway/credential-shaped identifier or field in actual code; zero import outside this repo's own `src/domain`; exact expected export surface; write-before-guard ordering for both admission registries.

**1713/1713 tests pass** (1683 pre-existing + 30 new), strict typecheck clean, zero new runtime dependency.

## Sanity-check disclosure

Five load-bearing guards were independently verified by temporary removal: (1) the replay-safety `appliedFactIds` check — removing it caused exactly the 2 tests proving that dimension (S18, S19) to fail, nothing else; (2) the ambiguous-customer-linkage guard, (3) the already-admitted-plan-mapping guard, (4) the cross-storefront rejection in `createPendingSubscription`, and (5) the tenant-isolation check in `deriveEntitlement` — disabled together, causing exactly the 5 tests proving those dimensions (S3, S4, S7, S21, S22) to fail, nothing else. All five were restored and the full suite reconfirmed green (1713/1713) after each check.

## Status

`IMPLEMENTED / SELF-VALIDATED`. `HOLD_MERGE` — inherited stacked lineage; independent Brain exact-head review required before any merge disposition. Not self-declared `VERIFIED`/`PASS`/`SAFE_MERGE`.

## Deliberately deferred, not fabricated

Live webhook signature verification, external-platform app credentials, and network transport; real gateway charging, recurring card storage, raw card handling; direct payment-gateway credentials/adapters; separate `Charge`/`Payment`/`Invoice` domain truths (not required by any of Rev59's named acceptance tests; the lifecycle's `PAYMENT_FAILED`/`PAYMENT_RECOVERED` facts are opaque signals only); HTTP/route/application-layer wiring (this is a pure domain-contract floor, matching every other "floor" checkpoint's established scope discipline). No live platform install/configuration, payment collection, invoice issuance, credentials, tax decision, customer charge, or production effect is authorized or attempted.
