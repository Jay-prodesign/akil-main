# APP-SUB-002 — Subscription Usage/Status Projection (OS V2 floor slice, continuation)

## Provenance

- Governing authority: canonical Handoff **REV215** ("FOUNDER AUTHORIZATION: V1 PRESERVATION + CONTINUOUS NEXT-PHASE DEVELOPMENT", AA-005, 2026-10-11), re-confirmed (fresh Drive read, this session) as the latest substantive canonical revision — AA-002's own content tops out at REV210 despite a later file-modified timestamp.
- Task-selection method per the Founder's explicit in-session direction (recorded in-repo as a PR #145 comment, id `6147630321`): primary selection is a **current-main + canonical-blueprint dependency scan**, not backlog-sweeping. This checkpoint was derived that way, not picked from the open-PR backlog.
- Canonical OS blueprint (Drive `1SsxLDjARcmv9QG04UWjUoCNl3QLsfm_vOrj7yQxgXWg`, "AKILTA OS — Core Definition & V0/V1/V2 Execution Blueprint — R1"), §"V2 — EXTERNAL COMMERCIAL RELEASE / GA". Of its required bullets, two remain buildable as pure dark/internal domain contracts with no real external provider: `APP-SUB-001` (subscription/entitlement lifecycle, already shipped as a prior checkpoint on branch `claude/app-sub-001-entitlement-core-v2`, PR #140) covered "subscription/contract → entitlement → ... → access lifecycle." The adjacent bullet — **"customer-facing usage/quota/credit and upgrade/downgrade/suspend/cancel flows"** — still needed its usage/quota half: a customer-safe read view that actually joins subscription/entitlement state to real usage data. This checkpoint is that join, and only that join.
- Dependency-map finding: `OS-V0-07`'s usage/quota/credit admission domain (`execution-quota-admission.ts`, with its fail-closed `QuotaReadModel` projection) is **already on `main`**. `APP-SUB-001`'s `Entitlement`/`Subscription` types are not yet on `main` — they exist only on PR #140's still-unmerged branch. No prior checkpoint had composed the two into the single view a customer-facing surface would need ("what am I subscribed to, is it active, what have I used"). Nothing else in the blueprint's V2 text is buildable right now without crossing a protected gate (production IdP, KMS, billing, legal terms, external pilot) or without first-building more unmerged foundation than this slice needs.
- Branch: `claude/app-sub-002-usage-status-projection`, cut from `origin/claude/app-sub-001-entitlement-core-v2` (PR #140's branch tip) — **stacked**, not cut from `main`, because `subscription-entitlement.ts` does not exist on `main` yet. This mirrors this corridor's own established stacked-branch precedent (e.g. the OS-V0-09→OS-V0-16 chain).

## Scope (this checkpoint)

- `src/domain/subscription-usage-status.ts` (new, 92 lines): `projectSubscriptionUsageStatus`, a pure, zero-persistence, zero-new-dependency composition function that joins an already-derived `Entitlement` (from `subscription-entitlement.ts`) and an already-projected `QuotaReadModel` (from `execution-quota-admission.ts`) into one `SubscriptionUsageStatus` customer-safe view, scoped to a given `Subscription`. Mirrors this repository's established composition pattern for this class of work (`CXP-ACT-001`'s `buildClientProjectSnapshot`, composing `ProjectActivationProfile`).
- Every field in `SubscriptionUsageStatus` is read-through verbatim from an already-fail-closed source (`subscriptionStatus` from `Subscription.status`, `isEntitled`/`entitlementRefs` from `Entitlement`, `usage` from `QuotaReadModel` unmodified) — nothing is fabricated, recomputed speculatively, or defaulted when a source value is absent.
- The one new invariant this module itself enforces: `projectSubscriptionUsageStatus` throws `InvalidSubscriptionUsageStatusError` unless both the supplied `entitlement` and `quotaScope` belong to the exact same `tenantId`/`customerId` as the `subscription` being projected — the same cross-scope ownership check every other composition boundary in this repository already enforces (mirrors `project-activation-profile.ts`'s own check). Without it, a caller could, by bug or malice, compose one customer's subscription with a different customer's quota/usage data into a single status view — a cross-customer data leak.
- `tests/subscription-usage-status.test.ts` (new, 8 tests — U1–U7 plus boundary scan B1): U1 happy-path full composition (ACTIVE subscription + active entitlement + populated quota read model); U2 `PENDING_ACTIVATION` subscription composes correctly with `isEntitled: false`/`entitlementRefs: []`; U3 adversarial — foreign-tenant entitlement throws; U4 adversarial — same-tenant, foreign-customer entitlement throws; U5 adversarial — foreign-tenant `quotaScope` throws; U6 adversarial — same-tenant, foreign-customer `quotaScope` throws; U7 a `NOT_CONFIGURED` monetary/quota state propagates verbatim (never silently defaulted or coerced); B1 boundary scan confirms the module imports only from `tenant-scope.ts`/`customer.ts`/`subscription-entitlement.ts`/`execution-quota-admission.ts` — zero `authority.ts`/`organization-membership.ts` coupling.
- Guard-disable sanity performed twice (once per fail-closed check in this module), each time reverted immediately after confirming the dependent tests actually fail without the guard: disabling the entitlement tenant/customer check made exactly U3/U4 fail; disabling the quotaScope tenant/customer check made exactly U5/U6 fail. Both guards confirmed restored to their normal form; full regression reconfirmed green after each revert.
- Full regression on this branch (after both reverts): **2718/2718 passing** (2710 pre-existing on PR #140's branch tip + 8 new), clean strict typecheck, zero new runtime dependency.

## Explicitly deferred (not fabricated)

- **No upgrade/downgrade/suspend/cancel flow wiring here.** That half of the blueprint bullet was already delivered by `APP-SUB-001`'s `changeSubscriptionPlan` plus the existing lifecycle-fact suspend/cancel paths; this checkpoint only adds the usage/quota *read* side, not a second copy of the write side.
- **No real metering/usage-event ingestion.** `usage` is read through verbatim from whatever `QuotaReadModel` the caller already projected via `projectQuotaReadModel` (OS-V0-07, already on `main`) — this module introduces no new usage-counting logic of its own.
- **No wiring into any live HTTP route, application-boundary operation, or admin UI.** Domain contract only, matching every prior floor-slice checkpoint's own scope discipline. A customer-facing route that calls this projection is a separate, later integration step.
- **No real billing/payment/credential/IdP/KMS/legal-terms/external-pilot work.** Those remain protected/Hard-Stop items per the blueprint and `CLAUDE.md`/`AGENTS.md`, untouched here.

## Architecture / semantic invariants (verified by test)

- `projectSubscriptionUsageStatus` never silently substitutes, drops, or coerces a source field — every output field is a direct pass-through (U1, U2, U7).
- A foreign or mismatched `entitlement` — wrong tenant, or same tenant but wrong customer — can never compose into a subscription's usage status; the function throws rather than producing a cross-customer view (U3–U4).
- A foreign or mismatched `quotaScope` — wrong tenant, or same tenant but wrong customer — can never compose into a subscription's usage status; the function throws rather than producing a cross-customer view (U5–U6).
- Both guards independently confirmed load-bearing via guard-disable sanity (see Scope above), then restored.
- Zero `authority.ts`/`organization-membership.ts` import anywhere in the module (B1).

## Hard Non-Scope

No modification to `subscription-entitlement.ts`, `execution-quota-admission.ts`, `tenant-scope.ts`, `customer.ts`, `authority.ts`, or `organization-membership.ts` — all consumed unmodified, type-only where applicable. No new runtime dependency. No route/application-boundary wiring. No real commerce-platform name, credential, or account anywhere.

## Stacked-branch disclosure

This branch (`claude/app-sub-002-usage-status-projection`) is cut from PR #140's branch tip, not from `main`, because its sole non-type-only dependency (`Subscription`/`Entitlement` from `subscription-entitlement.ts`) does not exist on `main` yet. The PR opened from this branch will therefore show PR #140's own diff as part of its range until PR #140 merges — this is disclosed explicitly in the PR description, consistent with this corridor's established stacked-PR precedent. This PR's own net-new diff is exactly the two files listed in Scope above.

## Evidence

- `npx tsc -p tsconfig.json` (clean `dist/` rebuild): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2718/2718 passing** (2710 pre-existing on PR #140's branch tip + 8 new).
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/subscription-usage-status.ts` (new), `tests/subscription-usage-status.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION: HOLD_MERGE` — stacked task-scoped PR, requires PR #140 to merge (or this branch to be rebased onto `main` after PR #140 merges) before it can itself be merged; merge requires its own separately-granted protected owner-gate, never inferred from any other PR's grant. Risk classification: LOW/MEDIUM, pure/dark-internal — this module remains unreferenced by any other `src/` file; no live platform install/config, credentials, payment, invoice issuance, tax/provider effect, or MAIN mutation.
