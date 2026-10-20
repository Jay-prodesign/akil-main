# V2-FLOOR-INT-002 — Full Customer Lifecycle Composition (test-only)

## Provenance

- Governing authority: canonical Handoff **REV215** (AA-005, 2026-10-11). Immediate trigger: Brain's reconciliation comment on PR #145 (id `6152530150`, "V2 IS NOT EXHAUSTED"), step 4: after correcting PR #147's F1 finding, reconciling PR #148, and shipping `CUS-OFFBOARD-002`, fresh-scan again and self-select the next task — explicitly not treating any of this as a stop.
- Fresh scan performed this session (current branch tip after merging `APP-BILL-001`'s and `CUS-OFFBOARD-002`'s branches onto `V2-FLOOR-INT-001`'s own tip): `APP-BILL-001` (PR #151) and `CUS-OFFBOARD-001`/`CUS-OFFBOARD-002` (PRs #149/#150) each landed with only ISOLATED unit/boundary-scan coverage, exactly mirroring the gap `V2-FLOOR-INT-001` itself closed for `ORG-ONBOARD-001`/`APP-SUB-001`/`APP-SUB-002` earlier this session. Neither module's own test suite ever constructs its inputs from a REAL admitted `Organization`'s own tenant — both hand-build a bare `TenantScope`/`Organization` directly. This is the next largest coherent, dependency-ready, reversible unit: extending `V2-FLOOR-INT-001`'s own golden-path composition one layer further to cover the two newer slices, mirroring that checkpoint's own established precedent exactly ("now that more floor slices exist, prove they compose") — not new business scope, only proof that already-authorized pieces fit together.

## Scope (this checkpoint)

- **Zero new production source.** `src/domain/organization-onboarding.ts` (`ORG-ONBOARD-001`), `src/domain/subscription-entitlement.ts`/`subscription-usage-status.ts` (`APP-SUB-001`/corrected `APP-SUB-002`), `src/domain/billing-reference.ts` (`APP-BILL-001`), `src/domain/customer-offboarding.ts` (`CUS-OFFBOARD-001`), and `src/domain/customer-offboarding-execution.ts` (`CUS-OFFBOARD-002`) are all consumed exactly as already accepted, with no modification.
- New `tests/v2-floor-int-002-full-lifecycle.test.ts` (3 tests):
  - **FULL1** (happy path): an `OrganizationOnboardingRequest` is submitted and admitted into a fresh `TenantScope`/`Organization`. A `Customer` is created in that same tenant, linked/subscribed/activated (`APP-SUB-001`), its `Entitlement` composed into a `SubscriptionUsageStatus` (`APP-SUB-002`). A `BillingReferenceRegistry` records an `externalInvoiceRef` against that real `Subscription` and advances it `ISSUED → PAID` (`APP-BILL-001`). A `CustomerOffboardingRequest` is then submitted against that same `Customer` and completed by a distinct, genuinely-GRANTED staff principal inside the SAME admitted organization (`CUS-OFFBOARD-001`), producing a `COMPLETED` request and export snapshot. The completed request drives a `CustomerOffboardingExecutionState` through `start`/`advance` (`CUS-OFFBOARD-002`), producing exactly 3 truthful `BLOCKED_UNSUPPORTED` resource dispositions. Every field across the full chain is asserted end to end.
  - **FULL2** (adversarial): two independently admitted organizations each produce a real `Subscription` under their own tenant. An `externalInvoiceRef` already bound to the first organization's subscription cannot be claimed by the second organization's subscription — `BillingReferenceRegistry`'s own cross-subscription fail-closed guard (already proven load-bearing in `APP-BILL-001`'s own guard-disable sanity round) continues to hold when both subscriptions' tenant identity originates from a real, independently-admitted onboarding flow rather than a bare hand-constructed `TenantScope`.
  - **FULL3** (adversarial): a `CustomerOffboardingRequest` submitted inside one admitted organization's tenant cannot be completed by a decider whose `EffectiveAccessResolution` is genuinely `GRANTED` with `canPerformProtectedActions` — but bound to a DIFFERENT admitted organization's own tenant. `completeCustomerOffboarding`'s own cross-tenant fail-closed guard (already proven load-bearing in `CUS-OFFBOARD-001`'s own guard-disable sanity round) continues to hold when the foreign decider's access is composed from a real, independently-admitted organization/membership chain, not a bare hand-constructed access resolution.
- No guard-disable sanity round was repeated for this checkpoint, for the same reason `V2-FLOOR-INT-001` itself gave: every fail-closed guard this composition exercises (`BillingReferenceRegistry`'s cross-subscription guard, `completeCustomerOffboarding`'s cross-tenant guard, `projectSubscriptionUsageStatus`'s ownership guard) was already independently confirmed load-bearing by its own module's guard-disable sanity round; re-disabling the same, unmodified guards here would not produce new evidence.
- Full regression on this branch: **2766/2766 passing** (2763 after merging `APP-BILL-001`'s and `CUS-OFFBOARD-002`'s branches onto `V2-FLOOR-INT-001`'s tip, + 3 new FULL tests), clean strict typecheck, zero new runtime dependency.

## Branch / stacking disclosure

- Branch: `claude/v2-floor-int-002-full-lifecycle`, cut from `origin/claude/v2-floor-int-001-golden-path` (PR #148's branch tip, itself stacked on PR #140/#141/#147's own ranges), with `APP-BILL-001`'s branch (`claude/app-bill-001-billing-reference-floor`, PR #151) and `CUS-OFFBOARD-002`'s branch (`claude/cus-offboard-002-execution-lifecycle`, PR #150, itself stacked on `CUS-OFFBOARD-001`'s branch, PR #149) each merged in non-destructively via `git merge` (no rebase, no history rewrite of any existing branch).
- Both merges produced a conflict ONLY in `docs/engineering/CURRENT_STATE.md`'s own top-of-file narrative (each branch had independently appended a new entry at the same location); resolved by keeping every entry from both sides, in chronological order, dropping nothing, mirroring `V2-FLOOR-INT-001`'s own established conflict-resolution precedent.
- This PR therefore carries PR #140's, PR #141's, PR #147's, PR #148's, PR #149's, PR #150's, and PR #151's full diffs in its range, plus this checkpoint's own test-only delta. It needs all of those merged (or this branch rebased onto `main` after they merge) before it can itself be merged — disclosed explicitly, not left implicit.

## Explicitly deferred (not fabricated)

- No HTTP route, admin UI, or additional billing/payment wiring — this remains a domain-level composition witness only, matching every prior floor-slice checkpoint's own scope discipline.
- No new production module, no new fail-closed guard, no new architecture — this checkpoint proves existing accepted primitives compose, it does not add a fifth one.
- No attempt at a "V2 exit audit" — V2 itself (External Commercial Release/GA) remains almost entirely Hard-Stop (production IdP/KMS/billing/legal terms/external pilot) — this is not framed as a V2 release-candidate checkpoint, only as a composition/integration proof for the floor slices that do exist.

## Hard Non-Scope

No modification to `organization-onboarding.ts`, `subscription-entitlement.ts`, `subscription-usage-status.ts`, `billing-reference.ts`, `customer-offboarding.ts`, `customer-offboarding-execution.ts`, `organization.ts`, `organization-membership.ts`, `effective-organization-access.ts`, `authority.ts`, `tenant-scope.ts`, or `customer.ts`. No new runtime dependency. No route/application-boundary wiring. No real commerce-platform name, credential, IdP, billing provider, or account anywhere.

## Evidence

- `rm -rf dist && npx tsc -p tsconfig.json` (clean rebuild): exit 0, zero errors.
- `npx tsc --noEmit -p tsconfig.json`: exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2766/2766 passing** (2763 after the two merges + 3 new FULL tests).
- `package.json`: zero new runtime dependency.
- Files touched (this checkpoint's own net-new delta, beyond the two merged-in branches' commits): `tests/v2-floor-int-002-full-lifecycle.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — stacked on PR #140/#141/#147/#148/#149/#150/#151's own ranges; merge requires all of those merged first, plus its own separately-granted protected owner-gate, never inferred from any other PR's grant. Risk classification: LOW, test-only — this checkpoint adds zero production source and references no module outside what those PRs already introduced.
