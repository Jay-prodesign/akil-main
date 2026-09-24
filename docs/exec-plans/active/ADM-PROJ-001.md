# ADM-PROJ-001 — Project Activation / Effective Execution Profile

## Provenance

- Governing authority: DEC-160/DEC-175 corridor; Brain/AKILTA Brain AA-005 ("AKILTA — Current Engineering Handoff") Rev98-101 (task authorization and exact patch-level implementation shape), Rev102/103 (execution-surface handoff and pre-implementation harness evidence), Rev104 (independent exact-head review, `CHANGES_REQUIRED`), Rev105 (PR-state reconciliation), Rev106 (single-handoff execution envelope), Rev107 (review of correction 1, `CHANGES_REQUIRED` — narrower, 3 findings), Rev108 (review of correction 2, `CHANGES_REQUIRED` — narrower still, 2 findings).
- `BASE_PROVENANCE_SHA` (full 40-character): `3226c76fa338e425e553638e5f5f48924182a1c0`.
- Branch: `claude/adm-proj-001-project-activation-profile`.
- **First implementation** (commit `9d109cdf455848fa91fde43b3cd8e68a9272fbe3`, PR #101): Brain Rev104 `CHANGES_REQUIRED`, 8 findings (F1-F8) — built from a compacted/paraphrased recollection of Rev101 rather than its verbatim text.
- **Correction 1** (commit `8f27ca912c825a0aaf27788fccc40fdd11805391`): rebuilt against Rev101's verbatim text, addressing all 8 Rev104 findings. Brain Rev107 confirmed F1/F3/F4/F5 (and the READY/ACTION_REQUIRED direction) resolved, but returned `CHANGES_REQUIRED` on 3 narrower points: `effectiveConfigRefs`/`effectivePolicyRefs` derived internally from the recipe instead of being independent inputs; an `ACTION_REQUIRED` `platformDecision` dropped from the profile/fingerprint; and an under-controlled A18 fingerprint test plus incomplete A11/A15/A17 lifecycle/ineligibility coverage.
- **Correction 2** (commit `79137f94a5149be36d02dc4bc60c25ff1902864c`): fixed all 3 Rev107 findings. Brain Rev108 confirmed Rev107 F1-F3 were materially corrected, but returned `CHANGES_REQUIRED` again on 2 more narrowly-scoped points: (F1) the fix for F2/Rev107 only covered the platform-decision step (step 7) — an earlier blocker (plan admission at step 5, or an earlier connection failure at step 6) still called `finish(..., platformDecision: undefined)`, so a supplied decision's provenance could still disappear depending on *which* blocker won; and within the step-6 connection loop, a later requirement's failure reset `verifiedConnections` to `[]`, discarding any earlier requirement's already-successful resolution in the same loop. (F2) `AcceptedCommercialReference` and `MaterialPlatformDecision` are plain exported interfaces, not opaque/branded types, so a caller could hand-construct one bypassing `createAcceptedCommercialReference`/`createMaterialPlatformDecision`'s own validation entirely (e.g. an empty `acceptanceRef` with matching equality fields, or an `ACTION_REQUIRED` decision with `actor: "NONE"`) and the compiler would accept it without independently re-checking.
- **This third correction** (commit pending push) fixes both Rev108 findings: every terminal `finish()` call in steps 5 and 6 now passes through `input.platformDecision` verbatim (not `undefined`) regardless of which blocker wins; the step-6 connection-loop blocking calls now pass the accumulated `verifiedConnections` array (not `[]`), preserving any requirement already resolved earlier in the same loop; and the compiler now re-invokes `createAcceptedCommercialReference`/`createMaterialPlatformDecision` on the supplied objects at its own boundary (discarding the return value; only the validation side effect matters), making both types' invariants non-bypassable regardless of whether the caller used the factory. Both new guards are self-proving by their own dedicated regression tests, so no additional manual A21 exercise was needed this round either, per Rev108's own conditional (identical to Rev107's).
- Per Rev106/107/108 ("Founder gate: NONE... Do not ask Founder for re-authorization... Do not idle for Founder dvm/continue"), all three correction rounds proceeded without a further Founder confirmation round-trip — Brain's own review is the authorizing verdict for this bounded correction lane.
- Bounded write surface for this correction (Rev106, unchanged): exactly `src/domain/project-activation-profile.ts`, `tests/project-activation-profile.test.ts`, `docs/exec-plans/active/ADM-PROJ-001.md`. No other file was touched.

## Goal

Compile a `ProjectActivationProfile`: a pure, deterministic readiness verdict for turning an accepted commercial scope into admitted, wired `OutcomeJob`s, built entirely by composing existing repository primitives — no new persistence, identity, billing, or runtime surface.

## Scope (corrected, per Rev101 verbatim)

`src/domain/project-activation-profile.ts`:

- `AcceptedCommercialReference` / `createAcceptedCommercialReference` — opaque upstream **provenance only**: `acceptanceRef`, `sourceBlueprintId`, `sourceBlueprintVersion`, `soldScopeId`, `outcomeContractRef`. No payload hash, no tenant/project binding, no `acceptedAt`/`acceptorRef`, and no acceptance-granting function (F1 correction — the first implementation's SHA-256 payload-hash/`isCommercialReferenceValidForSoldScope` model was rejected outright by Rev104 as inventing authority Rev101 never specified).
- `MaterialPlatformDecision` / `createMaterialPlatformDecision` — the Rev101 activation-time **input**: `RESOLVED` (requires `selectedOptionRef` + `actor: "NONE"`) vs `ACTION_REQUIRED` (requires a real actor, never a fabricated `selectedOptionRef`), both enforced at construction (F4 correction — the first implementation repurposed this name as an output blocker-kind record instead).
- `ActivationActor` (`NONE | CUSTOMER | AKILTA | HUMAN_REVIEW`), `ActivationState` (`READY | ACTION_REQUIRED` only — F5 correction, the first implementation exposed a third `BLOCKED` state Rev101 never specified).
- `ActivationWorkerRouteInput`, `NextRequiredAction` (`{code, reason}`), `VerifiedConnectionObservation` (`connectionRequirementId`, `connectionBindingId`, optional opaque `secretRef`, `verificationEvidenceRef` — nothing else is ever exposed), `ConsumedWorkerRoute`.
- `ProjectActivationProfile` — `version: 1`; exact tenant/customer/project/**caller-supplied** `ownership` (preserving any `serviceRef` — F2/Rev104 correction, the first implementation reconstructed ownership internally and silently dropped it); commercial/scope/blueprint/recipe/plan provenance; **independent caller-supplied** `effectiveConfigRefs`/`effectivePolicyRefs` (Rev107 F1 correction — never derived from `recipe.requiredContextRefs`/`recipe.policyRefs`, so a material effective-config/policy change is representable without mutating the recipe); `platformDecision`, preserved whenever supplied on **every** terminal outcome regardless of `RESOLVED`/`ACTION_REQUIRED` or which validation step actually terminated (Rev107 F2 + Rev108 F1 correction — a supplied decision's provenance, including `decisionRef`, is never dropped, whether the compiler blocks on the decision itself or on an earlier plan/connection blocker); `verifiedConnections`, accumulated across the entire connection-gate loop and preserved even when a later requirement in the same loop blocks (Rev108 F1 correction); `consumedRoutes`; `state`/`nextRequiredActor`/`nextRequiredAction`/`unresolvedGates`; `sourceFingerprint`; `compiledAt`.
- `ProjectActivationCompilation` — `{ profile, plan, planAdmission, specs, jobAdmissions, jobs }` (F2 correction — the existing `ProjectPlan`/`OutcomeJob` handoff artifacts are returned alongside the profile, not duplicated into it; `jobs` is empty unless `profile.state === "READY"`).
- `compileProjectActivationProfile(input)` — the exact Rev101 nine-step order, full detail in the function's own doc comment:
  0. Compiler-boundary re-validation (Rev108 F2): re-invokes `createAcceptedCommercialReference(input.acceptedCommercialReference)` and, if supplied, `createMaterialPlatformDecision(input.platformDecision)`, discarding the return value — this makes both types' own construction invariants non-bypassable at the compiler boundary, not just at construction time via the factory a caller might skip.
  1. Structural coherence (`customer`/`project`/`ownership`/`soldScope` vs `tenantScope`) — throws.
  2. `acceptedCommercialReference` exact equality to `blueprint`/`soldScope` — throws on mismatch, no inference.
  3. `recipe.jobFamily === blueprint.blueprintId` — throws on mismatch.
  4. `compilePlan` → `admitPlan` → `deriveOutcomeJobSpecs` → `admitJobs`, unconditionally.
  5. `planAdmission` not `ADMITTED`: unresolved scope → `CUSTOMER`; `plan-approval` wait or `BLOCKED` → `HUMAN_REVIEW` (F4/F5 correction — the first implementation mapped `BLOCKED` to `AKILTA`; Rev101 explicitly maps it to `HUMAN_REVIEW`). A supplied `platformDecision`'s provenance is preserved even here, before it is ever evaluated (Rev108 F1).
  6. Connection gate: exactly one compatible `VERIFIED` `ConnectionBinding` per in-scope `ConnectionRequirement`, matched by exact requirement id + ownership, with `delegatedScope` re-checked against `minimumProviderScope` **independently of the binding's own construction-time invariant** (F3 correction — the first implementation trusted a caller-supplied `CapabilityAdmission` object at face value instead of proving `ConnectionRequirement`/`ConnectionBinding` lineage itself). Zero matches → `CUSTOMER`/`AKILTA` by `accountOwner`; more than one → `AKILTA` (ambiguous). A requirement resolved earlier in this same loop is preserved in the terminal result even when a later requirement blocks (Rev108 F1).
  7. A supplied `platformDecision` with `status: "ACTION_REQUIRED"` blocks with its own actor, and its full provenance (including `decisionRef`) is preserved on the profile/fingerprint even while blocking (Rev107 F2).
  8. `resolveWorkerRoute` per supplied route; duplicate `routeRef` throws; `REJECTED` → `AKILTA`.
  9. Only once 1-8 are clean: `wireAdmittedOutcomeJobs`, `state: "READY"`.
- `sourceFingerprint` — SHA-256 over one explicit JSON payload containing the commercial reference, full `SoldScope` fields, full blueprint requirement shape, full `DeliveryRecipe` shape, compiled plan identity/nodes, effective config/policy refs, the platform decision, normalized verified-connection observations, and consumed routing input+decision (F6 correction — the first implementation's fingerprint omitted the recipe, full blueprint/soldScope shape, and platform decision, so a material source/config/policy/connection/routing change could leave a `BLOCKED`-vs-`BLOCKED` fingerprint unchanged).

## Explicitly deferred (not invented)

No new persistence/durable-store module, no HTTP/API surface, no real provider/model/commerce API call, no new worker/reviewer admission process, no new connection-verification mechanism, no production/publish/deploy effect, no invented recovery/retry semantics — unchanged from the original scope statement and still true of the corrected implementation.

## Architecture / semantic invariants (verified by test)

- `compileProjectActivationProfile` never mutates or persists anything and never reads the system clock; identical inputs always produce an identical `ProjectActivationCompilation`, `sourceFingerprint` included (A2).
- Structural mismatches (tenant/customer/project/ownership coherence, commercial-reference/blueprint/soldScope mismatch, recipe/blueprint jobFamily mismatch, a duplicate `workerRoutes` `routeRef`) always throw `InvalidProjectActivationProfileError` — never silently accepted, never turned into a business decision (A3-A6).
- `PlanAdmissionResult.BLOCKED` and a `plan-approval` `WAITING` both map to `HUMAN_REVIEW`; an unresolved sold-scope `WAITING` maps to `CUSTOMER` (A7, A8, and the `PLAN_ADMISSION_BLOCKED` case).
- A `REQUIRED`-disposition capability with no exactly-one compatible `VERIFIED` binding always blocks, with the actor determined solely by the connection requirement's own declared `accountOwner` (A9, A10); an unverified/foreign-ownership binding never counts as a candidate (A11, A12); more than one compatible `VERIFIED` binding is ambiguous and blocks `AKILTA` rather than picking arbitrarily (A13).
- An `ACTION_REQUIRED` `platformDecision` always blocks with its own declared actor, never a default, and its exact `decisionRef`/provenance always survives onto the profile — whether the decision itself is the blocker, or an earlier plan/connection blocker wins first (A14; Rev107 F2 and Rev108 F1 regression tests).
- A `ConnectionRequirement` resolved successfully earlier in the connection-gate loop is never erased from the terminal result by a later requirement's failure in the same loop (Rev108 F1 regression test).
- `AcceptedCommercialReference`/`MaterialPlatformDecision` invariants are enforced at the compiler boundary itself, not only inside their own factory functions — a hand-built object bypassing the factory is rejected identically (Rev108 F2 regression tests).
- A `REJECTED` worker-routing decision always blocks `AKILTA`; an ineligible preferred candidate — `UNTRUSTED`, `UNAVAILABLE`, under-authorized, or missing a required tool/policy constraint — is always skipped in favor of an eligible fallback without relaxing any requirement, exactly as `resolveWorkerRoute` itself already guarantees (A15-A17, 4 distinct ineligibility axes).
- A `VERIFIED` connection binding is the only lifecycle state that satisfies the connection gate — `CONNECTED_UNVERIFIED`, `DEGRADED`, and `REVOKED` bindings are all rejected the same way (A11, 3 cases).
- Independently varying `effectiveConfigRefs`, `effectivePolicyRefs`, the platform decision, a verified connection's evidence ref, or a consumed routing input — one field at a time, from an otherwise byte-identical base input — always changes `sourceFingerprint` (A18, controlled one-variable-at-a-time matrix per Rev107 F3).
- The serialized profile never contains a raw `providerRef`/`workspaceRef`/`integrationInstanceRef` — only the opaque binding id, an optional opaque `SecretRef` id, and the verification evidence ref (A19).
- `wireAdmittedOutcomeJobs` is reachable only once every one of the eight preceding gates is clean (A1).
- **A21 guard-disable sanity** (performed manually per Rev103's own precedent, not as a permanent test — first correction round only): the step-2 `sourceBlueprintVersion` equality guard was temporarily replaced with `false ||`, the suite was rebuilt and rerun — test A4 ("a commercial reference for the wrong blueprintVersion throws") failed exactly as expected, confirming the guard is load-bearing; the guard was then restored byte-for-byte (`diff` confirmed) and the full suite re-ran green. The second (Rev107) round's two new guards, and the third (Rev108) round's three new guards (platform-decision/verifiedConnections preservation across earlier blockers; compiler-boundary re-validation of both task-local record types), are each self-proving by their own dedicated adversarial/regression tests, so per Rev107/Rev108's own identical conditional no further manual A21 exercise was required for any of them.

## Hard Non-Scope

No new database/identity/billing/runtime surface. No modification to any existing domain file — every composed primitive (`project-plan.ts`, `plan-admission.ts`, `outcome-job-spec.ts`, `outcome-job-wiring.ts`, `outcome-job.ts`, `connection-authority.ts`, `worker-routing-policy.ts`, `approval-reference.ts`, `sold-scope.ts`, `project-ownership.ts`, `delivery-recipe.ts`) is imported and consumed exactly as it already exists, unchanged. No secret/credential material. PR #63 (`claude/authority-migration-001`) and PR #100 (`claude/v5x-cap-001-idea-valuation`) are untouched by this checkpoint. No MAIN mutation, merge, or deploy.

## EXEC-PLAN INVARIANTS (Rev101)

EI-1 NOT_APPLICABLE (pure non-effecting compiler) · EI-2 NOT_APPLICABLE (no effect/idempotency store; deterministic replay tested, A2) · EI-3 DEFERRED-BY-ACTIVATION (later effect/resume) · EI-4 IN_SCOPE (structural tenant/customer/project/connection scope) · EI-5 NOT_APPLICABLE (no metered fan-out) · EI-6 IN_SCOPE (no AKILTA↔AI Commerce authority merge) · EI-7 NOT_APPLICABLE (no learning/retrieval promotion).

## Test Coverage

`tests/project-activation-profile.test.ts` (37 tests) — the full Rev101 "TEST MATRIX (minimum)" A1-A20 with Rev107/Rev108's controlled/expanded coverage, plus construction-validation tests for `AcceptedCommercialReference`/`MaterialPlatformDecision`, F1/F2 regression tests (Rev108), and the boundary/dependency-delta checks folded in as `A20/boundary` (kept in this one file per Rev106's three-file bounded write surface, rather than a separate boundary-scan file):

| Rev101 ref | Covered by |
|---|---|
| A1 happy path → READY + wired DRAFT jobs | "A1: a fully clean activation..." |
| A2 determinism (deep-equal + fingerprint) | "A2: identical inputs..." |
| A3 foreign customer/project/ownership rejects | 2 tests |
| A4 commercial ref blueprint mismatch rejects | 1 test |
| A5 commercial ref soldScope/outcomeContract mismatch rejects | 1 test |
| A6 recipe/jobFamily mismatch rejects | 1 test |
| A7 missing/stale approval → HUMAN_REVIEW, zero jobs | 1 test |
| A8 unresolved sold-scope → CUSTOMER, zero jobs | 1 test (+ 1 extra `PLAN_ADMISSION_BLOCKED` case) |
| A9 missing CUSTOMER_OWNED connection → CUSTOMER | 1 test |
| A10 missing AKILTA_MANAGED connection → AKILTA | 1 test |
| A11 unverified/`DEGRADED`/`REVOKED` connection cannot satisfy | 3 tests (Rev107 F3: full lifecycle) |
| A12 cross-project binding rejects | 1 test |
| A13 ambiguous multiple VERIFIED bindings rejects | 1 test |
| Rev108 F1 regression: a connection resolved earlier in the loop survives a later requirement's block; its evidence is still fingerprint-load-bearing | 1 test |
| Rev108 F1 regression: a supplied platformDecision survives provenance/fingerprint even when an earlier plan blocker wins | 1 test |
| A14 unresolved platform decision blocks with declared actor, provenance preserved | 1 test |
| Rev107 F2 regression: two ACTION_REQUIRED decisions, same reason/actor, different decisionRef → different fingerprint | 1 test |
| Rev108 F2 regression: compiler rejects a hand-built `AcceptedCommercialReference`/`MaterialPlatformDecision` bypassing factory invariants | 3 tests |
| A15/A17 ineligible preferred worker (`UNTRUSTED`/`UNAVAILABLE`/under-authorized/missing-constraint) skipped, eligible fallback routes without relaxing requirements | 4 tests (Rev107 F3: all 4 ineligibility axes) |
| A16 rejected route → AKILTA, zero jobs | 1 test |
| A18 independent one-variable-at-a-time config/policy/platform/connection-evidence/routing mutation each change the fingerprint | 1 test, 5 sub-assertions (Rev107 F3: controlled matrix) |
| A19 no raw secret/credential field in serialized output | 1 test |
| A20 boundary scan (no AI Commerce/provider SDK/fetch/HTTP/store/Date.now/randomness) + dependency delta | 2 tests |
| A21 guard-disable sanity | manual exercise (first round only), recorded above; every later round's new guards are self-proving by their own dedicated tests |
| duplicate `routeRef` throws | 1 test |

## Validation

- `npx tsc --noEmit`: clean (including `exactOptionalPropertyTypes` compliance).
- Clean rebuild discipline (per the V5X-CAP-001 finding that `npm run build` does not clean `dist/` first): `rm -rf dist && npm run build`, then `node --test dist/tests/*.test.js`.
- Result: **745/745 tests pass** (708 pre-existing on `main@3226c76fa338e425e553638e5f5f48924182a1c0` + 37 in `project-activation-profile.test.ts`). Zero regressions, zero skips.
- First-round A21 guard-disable sanity performed and reverted as described above; full suite re-confirmed green after restore. Second- and third-round (Rev107/Rev108) guards are each self-proving by their own dedicated regression tests.

## Status

`IMPLEMENTED / SELF-VALIDATED`. Per `AGENTS.md` §10 and this repository's `CLAUDE.md`, Claude's authority ends here. This third correction addresses every Rev108 finding (F1-F2) on top of the already-resolved Rev104 and Rev107 findings; it stays **OPEN/DRAFT/HOLD_MERGE** on PR #101 pending independent Brain re-review of the new exact head. No merge, no MAIN mutation.
