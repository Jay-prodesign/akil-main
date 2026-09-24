# CXP-ACT-001 — Activation Required Action → Client Snapshot Projection

## Provenance

- Governing authority: DEC-160/DEC-175 corridor; Brain/AKILTA Brain AA-005 ("AKILTA — Current Engineering Handoff") Rev110 ("ADM-PROJ-001 EXACT-HEAD REVIEW PASS/VERIFIED + NEXT SOURCE HANDOFF").
- **Selection reasoning (Brain's own, Rev110)**: PR #101 (ADM-PROJ-001) reached `PASS/VERIFIED / TASK-LOCAL CLOSED` at exact head `9ae3063d81169d668f770dd7350907dc9360f464` after five review rounds (Rev104→109). DEC-175 requires the smallest evidence-exposed owner-free edge after ADM-PROJ — fresh main inspection confirmed a customer-safe `ClientProjectSnapshot` contract already exists (`src/domain/client-project-snapshot.ts`, V2-CDO-005) and the existing shell already renders `snapshot.nextAction` without reaching into raw domain internals. The production-activation alternative (actually executing/wiring jobs) is protected by real credential/provider/customer-effect gates, so the dependency-safe next slice is this read-only projection of activation readiness into the existing customer-safe `nextAction` field.
- **Explicit admitted dependency (Rev110, an explicit exception to the default "unmerged PR code is evidence only" rule)**: this task may consume only PR #101's exact `PASS` head `9ae3063d81169d668f770dd7350907dc9360f464` as its one unmerged source dependency, plus primitives already on `main@3226c76fa338e425e553638e5f5f48924182a1c0`. PR #100 and PR #63 remain out of scope.
- `BASE_PROVENANCE_SHA` (full 40-character, the tip of `claude/adm-proj-001-project-activation-profile`, not `main`): `9ae3063d81169d668f770dd7350907dc9360f464`. Independently re-verified via `git fetch`/`git rev-parse` immediately before branching — local and remote matched exactly.
- Branch: `claude/cxp-act-001-activation-required-action-projection`, created via `git checkout -b ... 9ae3063d81169d668f770dd7350907dc9360f464` (not from `main`, per Rev110's explicit instruction — Brain's own connected GitHub integration could not create this branch itself, 403 Resource not accessible by integration; an execution-surface limitation, not a Founder gate).
- Per Rev110 ("Founder gate: NONE... Claude must begin CXP-ACT-001 from the durable handoff without waiting for Founder 'devam/continue'"), this task proceeded without a Founder confirmation round-trip — Brain's own dispatch is the authorizing verdict.
- Bounded write surface (Rev110, exact): `src/domain/client-project-snapshot.ts`, `tests/client-project-snapshot.test.ts`, `docs/exec-plans/active/CXP-ACT-001.md`. No web/shell file change is authorized (the existing shell already renders `snapshot.nextAction`); no fixture/package/config/workflow/persistence/IAM/provider/AI-Commerce mutation.

## Goal

Add an optional `ProjectActivationProfile` (ADM-PROJ-001) input to `buildClientProjectSnapshot`, so that when activation readiness reports `ACTION_REQUIRED`, that becomes the authoritative pre-execution `nextAction` source for the customer-safe snapshot — without duplicating ADM-PROJ-001's own compiler/authority semantics, without exposing any of its internal provenance, and without changing `ClientProjectSnapshot`'s public shape.

## Scope

`src/domain/client-project-snapshot.ts`:

- `buildClientProjectSnapshot` gains one new optional input: `activationProfile?: ProjectActivationProfile` (type-only import from `./project-activation-profile.js` — no value/runtime dependency on ADM-PROJ-001's compiler, verified by the existing V2-CDO-005 boundary scan, unmodified).
- When supplied, `activationProfile.ownership` must exactly match the snapshot's own `ownership` tuple (`tenantId`/`customerId`/`projectId`/`serviceRef`, reusing the existing `ownershipEquals` helper) — any mismatch throws `InvalidClientProjectSnapshotError`.
- Only the two fields this projection actually consumes (`state`, `nextRequiredActor`) are re-validated for internal consistency — this is deliberately not a re-implementation of ADM-PROJ-001's own validator:
  - `state === "READY"` requires `nextRequiredActor === "NONE"` and no `nextRequiredAction` — otherwise throws (a tampered/hand-built object cannot claim READY while also carrying a pending action).
  - `state === "ACTION_REQUIRED"` requires `nextRequiredActor !== "NONE"` and a present `nextRequiredAction` — otherwise throws.
  - `nextRequiredActor` is mapped explicitly (`"CUSTOMER"` → `CLIENT_ACTION_REQUIRED`; `"AKILTA"`/`"HUMAN_REVIEW"` → `AKILTA_ACTION_REQUIRED`) — any other runtime value (a malformed/tampered actor, or an unrecognized `state`) throws rather than falling through to a default.
- When `state === "ACTION_REQUIRED"`, the resulting `NextAction` **replaces** any communication-derived value entirely (activation readiness is authoritative pre-execution) and never carries a `relatedCommunicationId`. When `state === "READY"`, the existing communication-derived `nextAction` logic is left completely untouched.
- No new `ClientProjectSnapshot` public field was needed — `NextActionOwner`'s existing `CLIENT_ACTION_REQUIRED`/`AKILTA_ACTION_REQUIRED` literals already cover both activation-derived cases; zero public-shape expansion.
- Nothing beyond `state`/`nextRequiredActor` is ever read from `ProjectActivationProfile` — `nextRequiredAction.reason`/`.code`, `unresolvedGates`, `platformDecision`, `verifiedConnections`, `consumedRoutes`, `sourceFingerprint`, `acceptedCommercialReference`, `effectiveConfigRefs`/`effectivePolicyRefs`, and any routing/provider/workspace identifier are never copied or exposed.

## Explicitly deferred (not invented)

No new `ClientProjectSnapshot` output field. No web/shell change (the existing shell already renders `nextAction`). No production activation, no execution/approval authority, no `OutcomeJob`/`ProjectPlan`/communication state mutation, no persistence/network/provider action. No re-implementation of ADM-PROJ-001's compiler or fingerprint logic — this module treats `ProjectActivationProfile` purely as an already-computed, structurally-typed input.

## Architecture / semantic invariants (verified by test)

- Activation readiness (`ACTION_REQUIRED`) always takes precedence over a conflicting communication-derived `nextAction`, and `READY` never disturbs the existing communication-derived behavior (A4, A5).
- `CUSTOMER` always maps to `CLIENT_ACTION_REQUIRED`; both `AKILTA` and `HUMAN_REVIEW` map to `AKILTA_ACTION_REQUIRED` — from the customer's point of view, an internal AKILTA reviewer gate is indistinguishable from routine AKILTA-side work (A1-A3).
- An `activationProfile` belonging to a different customer, project, or `serviceRef` is rejected exactly like every other cross-tenant input this module already guards (`plan`, `communicationHistory`, `capabilityAdmissions`) — the same `ownershipEquals` helper, no new comparison logic (A6).
- A hand-built or tampered `ProjectActivationProfile`-shaped object can never manufacture a client action: `READY` with a non-`NONE` actor or a present action rejects; `ACTION_REQUIRED` with actor `NONE`, a missing action, or an unrecognized actor/state value all reject (A7) — this is the module's own independent re-validation, not a trust of the caller's construction.
- An activation-derived `nextAction` never carries a `relatedCommunicationId` (A8), and the serialized snapshot never contains any `ProjectActivationProfile`-internal provenance field (A9) — the existing P3 forbidden-field discipline is extended, not replaced.
- Identical inputs (with or without an `activationProfile`) remain fully deterministic, and omitting `activationProfile` entirely reproduces the pre-existing WEBSITE_BUILD_v1/client-snapshot behavior exactly (A10) — this is an additive, backward-compatible input, not a behavior change to any existing caller.
- All new guards above are self-proving by their own dedicated adversarial tests in this same change (reverting any one of them makes its own test fail), so no additional manual guard-disable sanity exercise was needed, per Rev110's own conditional ("focused guard-disable sanity only for a new guard not already self-proven by its adversarial test") — the same pattern already established across ADM-PROJ-001's correction rounds.

## Hard Non-Scope

No new database/identity/billing/runtime surface. No web/shell file touched. No modification to `project-activation-profile.ts` or any other existing domain file — `ProjectActivationProfile` is imported type-only and consumed exactly as ADM-PROJ-001 already defines it. No secret/credential material. PR #63, PR #100, and PR #101 itself are untouched by this checkpoint (PR #101 is explicitly `PASS/VERIFIED` and read-only per Rev110's own "PR CLASSIFICATION"). No MAIN mutation, merge, or deploy.

## EXEC-PLAN INVARIANTS

Following ADM-PROJ-001's own EI classification pattern (Brain did not restate EI-1..EI-7 explicitly in Rev110's dispatch text; this is the implementing engineer's own consistent derivation, disclosed as such): EI-1 NOT_APPLICABLE (pure non-effecting read projection) · EI-2 NOT_APPLICABLE (no effect/idempotency store; deterministic replay tested, A10) · EI-3 DEFERRED-BY-ACTIVATION (a real production activation surface remains protected by credential/provider gates, per Rev110's own selection reasoning) · EI-4 IN_SCOPE (structural tenant/customer/project/serviceRef ownership scope enforced) · EI-5 NOT_APPLICABLE (no metered fan-out) · EI-6 IN_SCOPE (no AKILTA↔AI Commerce authority merge — this module has no commerce/provider coupling at all) · EI-7 NOT_APPLICABLE (no learning/retrieval promotion).

## Test Coverage

`tests/client-project-snapshot.test.ts` — 11 new tests (A1-A10, with A7 split across two tests) added to the existing 21 P1-P12 tests, none of which were modified:

| Rev110 ref | Covered by |
|---|---|
| A1 ACTION_REQUIRED/CUSTOMER → CLIENT_ACTION_REQUIRED | "CXP-ACT-001 A1" |
| A2 ACTION_REQUIRED/AKILTA → AKILTA_ACTION_REQUIRED | "CXP-ACT-001 A2" |
| A3 ACTION_REQUIRED/HUMAN_REVIEW → AKILTA_ACTION_REQUIRED | "CXP-ACT-001 A3" |
| A4 READY preserves communication-derived action + NO_ACTION_NEEDED fallback | "CXP-ACT-001 A4" |
| A5 activation ACTION_REQUIRED takes precedence over a conflicting communication action | "CXP-ACT-001 A5" |
| A6 ownership mismatch (customerId/projectId/serviceRef) rejects | "CXP-ACT-001 A6" |
| A7 hand-built/tampered state/actor/action combinations cannot manufacture client action | 2 tests ("CXP-ACT-001 A7" ×2) |
| A8 activation-derived result carries no relatedCommunicationId | "CXP-ACT-001 A8" |
| A9 serialized snapshot contains no forbidden internal activation provenance | "CXP-ACT-001 A9" |
| A10 determinism + unchanged existing behavior when no activationProfile is supplied | "CXP-ACT-001 A10" |

## Validation

- `npx tsc --noEmit`: clean (including `exactOptionalPropertyTypes` compliance).
- Clean rebuild discipline: `rm -rf dist && npm run build`, then `node --test dist/tests/*.test.js`.
- Targeted: `node --test dist/tests/client-project-snapshot.test.js` → 32/32 pass (21 pre-existing + 11 new).
- Existing `tests/v2-cdo-005-boundary-scan.test.ts` (unmodified — outside this task's three-file write surface) still passes unchanged: the new `ProjectActivationProfile` import is type-only, so it introduces no new value/runtime dependency.
- Full regression: **758/758 tests pass** (747 pre-existing on branch tip `9ae3063d81169d668f770dd7350907dc9360f464` + 11 new). Zero regressions, zero skips.

## Status

`IMPLEMENTED / SELF-VALIDATED`, independently confirmed by **Brain Rev111: PASS/VERIFIED / TASK-LOCAL CLOSED** at exact head `fe6b333e3b38d839acb2bc0fbba9a37d3d271224` — no correction round was required. Per `AGENTS.md` §10 and this repository's `CLAUDE.md`, Claude's authority still ends at IMPLEMENTED; PASS/VERIFIED is Brain's independent verdict, not a merge authorization. This is a Draft PR stacked against `claude/adm-proj-001-project-activation-profile` (not `main`), so its only unmerged dependency is explicit and reviewable. Stays **OPEN/DRAFT/HOLD_MERGE**. No merge, no MAIN mutation, no production activation.

Per Rev111's "NEXT AUTHORITY RECONCILIATION": DEC-175's first post-ADM-PROJ evidence-exposed customer-safe edge is now closed. Brain must fresh-reconcile AA-002 + DEC-175 + the live dependency graph before selecting another source task — no new task is to be manufactured merely to stay busy. This task's execution train ends here pending that reconciliation.
