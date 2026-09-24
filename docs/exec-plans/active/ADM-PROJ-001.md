# ADM-PROJ-001 — Project Activation / Effective Execution Profile

## Provenance

- Governing authority: DEC-160/DEC-175 corridor; Brain/AKILTA Brain AA-005 ("AKILTA — Current Engineering Handoff") Rev98-101 (task authorization and exact patch-level implementation shape), Rev102/103 (execution-surface handoff and pre-implementation harness evidence), Rev104 (independent exact-head review, `CHANGES_REQUIRED`), Rev105 (PR-state reconciliation), Rev106 (single-handoff execution envelope), Rev107 (independent review of the Rev104 correction, `CHANGES_REQUIRED` — narrower, 3 findings).
- `BASE_PROVENANCE_SHA` (full 40-character): `3226c76fa338e425e553638e5f5f48924182a1c0`.
- Branch: `claude/adm-proj-001-project-activation-profile`.
- **First implementation** (commit `9d109cdf455848fa91fde43b3cd8e68a9272fbe3`, PR #101) was reviewed by Brain Rev104 and returned `CHANGES_REQUIRED`: eight findings (F1-F8), all stemming from the same root cause — that implementation was built from a compacted/paraphrased recollection of Rev101 rather than its verbatim text.
- **First correction** (commit `8f27ca912c825a0aaf27788fccc40fdd11805391`) rebuilt the module against Rev101's verbatim text and addressed all eight Rev104 findings. Brain's Rev107 independent re-review confirmed F1/F3/F4/F5 (and the READY/ACTION_REQUIRED state-and-actor direction) were materially resolved, but returned `CHANGES_REQUIRED` again on three narrower, load-bearing points: (F1) `effectiveConfigRefs`/`effectivePolicyRefs` were derived internally from `recipe.requiredContextRefs`/`recipe.policyRefs` instead of being independent activation-time inputs; (F2) an `ACTION_REQUIRED` `platformDecision` was dropped from the profile/fingerprint (`platformDecision: undefined` on that blocking path), so two distinct decisions with the same reason/actor but different `decisionRef` could collide on the same fingerprint; (F3) the A18 fingerprint-mutation test varied multiple things at once (entangling `planId`/`soldScope` with the field under test) instead of one controlled variable at a time, and A11/A15/A17 didn't cover the full `DEGRADED`/`REVOKED` connection-lifecycle and worker-ineligibility axes Rev104 had already asked for.
- **This second correction** (commit pending push) fixes all three Rev107 findings: `effectiveConfigRefs`/`effectivePolicyRefs` are now required, independently-validated caller inputs recorded verbatim in the profile and fingerprint; the `ACTION_REQUIRED` platform-decision path now preserves the full supplied `MaterialPlatformDecision` (including `decisionRef`) on the profile/fingerprint; and the test matrix now performs genuine one-variable-at-a-time fingerprint mutations from one shared base input, plus `DEGRADED`/`REVOKED` connection cases and `UNAVAILABLE`/under-authorized/missing-constraint worker-fallback cases. Both new guards are self-proving by their own ordinary adversarial tests (reverting either fix makes its own test fail), so no additional manual A21 exercise was needed this round, per Rev107's own conditional ("only for any newly added guard whose ordinary adversarial test does not already prove it").
- Per Rev106/Rev107 ("Founder gate: NONE... Do not ask Founder for re-authorization... Do not idle for Founder dvm/continue"), both corrections proceeded without a further Founder confirmation round-trip — Brain's own review is the authorizing verdict for this bounded correction lane.
- Bounded write surface for this correction (Rev106, unchanged): exactly `src/domain/project-activation-profile.ts`, `tests/project-activation-profile.test.ts`, `docs/exec-plans/active/ADM-PROJ-001.md`. No other file was touched.

## Goal

Compile a `ProjectActivationProfile`: a pure, deterministic readiness verdict for turning an accepted commercial scope into admitted, wired `OutcomeJob`s, built entirely by composing existing repository primitives — no new persistence, identity, billing, or runtime surface.

## Scope (corrected, per Rev101 verbatim)

`src/domain/project-activation-profile.ts`:

- `AcceptedCommercialReference` / `createAcceptedCommercialReference` — opaque upstream **provenance only**: `acceptanceRef`, `sourceBlueprintId`, `sourceBlueprintVersion`, `soldScopeId`, `outcomeContractRef`. No payload hash, no tenant/project binding, no `acceptedAt`/`acceptorRef`, and no acceptance-granting function (F1 correction — the first implementation's SHA-256 payload-hash/`isCommercialReferenceValidForSoldScope` model was rejected outright by Rev104 as inventing authority Rev101 never specified).
- `MaterialPlatformDecision` / `createMaterialPlatformDecision` — the Rev101 activation-time **input**: `RESOLVED` (requires `selectedOptionRef` + `actor: "NONE"`) vs `ACTION_REQUIRED` (requires a real actor, never a fabricated `selectedOptionRef`), both enforced at construction (F4 correction — the first implementation repurposed this name as an output blocker-kind record instead).
- `ActivationActor` (`NONE | CUSTOMER | AKILTA | HUMAN_REVIEW`), `ActivationState` (`READY | ACTION_REQUIRED` only — F5 correction, the first implementation exposed a third `BLOCKED` state Rev101 never specified).
- `ActivationWorkerRouteInput`, `NextRequiredAction` (`{code, reason}`), `VerifiedConnectionObservation` (`connectionRequirementId`, `connectionBindingId`, optional opaque `secretRef`, `verificationEvidenceRef` — nothing else is ever exposed), `ConsumedWorkerRoute`.
- `ProjectActivationProfile` — `version: 1`; exact tenant/customer/project/**caller-supplied** `ownership` (preserving any `serviceRef` — F2/Rev104 correction, the first implementation reconstructed ownership internally and silently dropped it); commercial/scope/blueprint/recipe/plan provenance; **independent caller-supplied** `effectiveConfigRefs`/`effectivePolicyRefs` (Rev107 F1 correction — never derived from `recipe.requiredContextRefs`/`recipe.policyRefs`, so a material effective-config/policy change is representable without mutating the recipe); `platformDecision`, preserved whenever supplied regardless of `RESOLVED`/`ACTION_REQUIRED` (Rev107 F2 correction — an unresolved decision still blocks activation, but its exact provenance, including `decisionRef`, is never dropped from the output); `verifiedConnections`; `consumedRoutes`; `state`/`nextRequiredActor`/`nextRequiredAction`/`unresolvedGates`; `sourceFingerprint`; `compiledAt`.
- `ProjectActivationCompilation` — `{ profile, plan, planAdmission, specs, jobAdmissions, jobs }` (F2 correction — the existing `ProjectPlan`/`OutcomeJob` handoff artifacts are returned alongside the profile, not duplicated into it; `jobs` is empty unless `profile.state === "READY"`).
- `compileProjectActivationProfile(input)` — the exact Rev101 nine-step order, full detail in the function's own doc comment:
  1. Structural coherence (`customer`/`project`/`ownership`/`soldScope` vs `tenantScope`) — throws.
  2. `acceptedCommercialReference` exact equality to `blueprint`/`soldScope` — throws on mismatch, no inference.
  3. `recipe.jobFamily === blueprint.blueprintId` — throws on mismatch.
  4. `compilePlan` → `admitPlan` → `deriveOutcomeJobSpecs` → `admitJobs`, unconditionally.
  5. `planAdmission` not `ADMITTED`: unresolved scope → `CUSTOMER`; `plan-approval` wait or `BLOCKED` → `HUMAN_REVIEW` (F4/F5 correction — the first implementation mapped `BLOCKED` to `AKILTA`; Rev101 explicitly maps it to `HUMAN_REVIEW`).
  6. Connection gate: exactly one compatible `VERIFIED` `ConnectionBinding` per in-scope `ConnectionRequirement`, matched by exact requirement id + ownership, with `delegatedScope` re-checked against `minimumProviderScope` **independently of the binding's own construction-time invariant** (F3 correction — the first implementation trusted a caller-supplied `CapabilityAdmission` object at face value instead of proving `ConnectionRequirement`/`ConnectionBinding` lineage itself). Zero matches → `CUSTOMER`/`AKILTA` by `accountOwner`; more than one → `AKILTA` (ambiguous).
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
- An `ACTION_REQUIRED` `platformDecision` always blocks with its own declared actor, never a default, and its exact `decisionRef`/provenance always survives onto the profile (A14, F2 regression test).
- A `REJECTED` worker-routing decision always blocks `AKILTA`; an ineligible preferred candidate — `UNTRUSTED`, `UNAVAILABLE`, under-authorized, or missing a required tool/policy constraint — is always skipped in favor of an eligible fallback without relaxing any requirement, exactly as `resolveWorkerRoute` itself already guarantees (A15-A17, 4 distinct ineligibility axes).
- A `VERIFIED` connection binding is the only lifecycle state that satisfies the connection gate — `CONNECTED_UNVERIFIED`, `DEGRADED`, and `REVOKED` bindings are all rejected the same way (A11, 3 cases).
- Independently varying `effectiveConfigRefs`, `effectivePolicyRefs`, the platform decision, a verified connection's evidence ref, or a consumed routing input — one field at a time, from an otherwise byte-identical base input — always changes `sourceFingerprint` (A18, controlled one-variable-at-a-time matrix per Rev107 F3).
- The serialized profile never contains a raw `providerRef`/`workspaceRef`/`integrationInstanceRef` — only the opaque binding id, an optional opaque `SecretRef` id, and the verification evidence ref (A19).
- `wireAdmittedOutcomeJobs` is reachable only once every one of the eight preceding gates is clean (A1).
- **A21 guard-disable sanity** (performed manually per Rev103's own precedent, not as a permanent test — first correction round only): the step-2 `sourceBlueprintVersion` equality guard was temporarily replaced with `false ||`, the suite was rebuilt and rerun — test A4 ("a commercial reference for the wrong blueprintVersion throws") failed exactly as expected, confirming the guard is load-bearing; the guard was then restored byte-for-byte (`diff` confirmed) and the full suite re-ran green. The second (Rev107) correction round added two new guards — independent `effectiveConfigRefs`/`effectivePolicyRefs` fingerprint binding, and `ACTION_REQUIRED` platform-decision provenance preservation — both of which are self-proving by their own ordinary adversarial tests (A18's config/policy sub-cases; the F2 regression test), so per Rev107's own conditional no further manual A21 exercise was required for them.

## Hard Non-Scope

No new database/identity/billing/runtime surface. No modification to any existing domain file — every composed primitive (`project-plan.ts`, `plan-admission.ts`, `outcome-job-spec.ts`, `outcome-job-wiring.ts`, `outcome-job.ts`, `connection-authority.ts`, `worker-routing-policy.ts`, `approval-reference.ts`, `sold-scope.ts`, `project-ownership.ts`, `delivery-recipe.ts`) is imported and consumed exactly as it already exists, unchanged. No secret/credential material. PR #63 (`claude/authority-migration-001`) and PR #100 (`claude/v5x-cap-001-idea-valuation`) are untouched by this checkpoint. No MAIN mutation, merge, or deploy.

## EXEC-PLAN INVARIANTS (Rev101)

EI-1 NOT_APPLICABLE (pure non-effecting compiler) · EI-2 NOT_APPLICABLE (no effect/idempotency store; deterministic replay tested, A2) · EI-3 DEFERRED-BY-ACTIVATION (later effect/resume) · EI-4 IN_SCOPE (structural tenant/customer/project/connection scope) · EI-5 NOT_APPLICABLE (no metered fan-out) · EI-6 IN_SCOPE (no AKILTA↔AI Commerce authority merge) · EI-7 NOT_APPLICABLE (no learning/retrieval promotion).

## Test Coverage

`tests/project-activation-profile.test.ts` (32 tests) — the full Rev101 "TEST MATRIX (minimum)" A1-A20 with Rev107's controlled/expanded coverage, plus construction-validation tests for `AcceptedCommercialReference`/`MaterialPlatformDecision`, an F2 regression test, and the boundary/dependency-delta checks folded in as `A20/boundary` (kept in this one file per Rev106's three-file bounded write surface, rather than a separate boundary-scan file):

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
| A14 unresolved platform decision blocks with declared actor, provenance preserved | 1 test |
| A15/A17 ineligible preferred worker (`UNTRUSTED`/`UNAVAILABLE`/under-authorized/missing-constraint) skipped, eligible fallback routes without relaxing requirements | 4 tests (Rev107 F3: all 4 ineligibility axes) |
| A16 rejected route → AKILTA, zero jobs | 1 test |
| A18 independent one-variable-at-a-time config/policy/platform/connection-evidence/routing mutation each change the fingerprint | 1 test, 5 sub-assertions (Rev107 F3: controlled matrix) |
| F2 regression: two ACTION_REQUIRED decisions, same reason/actor, different decisionRef → different fingerprint | 1 test (Rev107 F2) |
| A19 no raw secret/credential field in serialized output | 1 test |
| A20 boundary scan (no AI Commerce/provider SDK/fetch/HTTP/store/Date.now/randomness) + dependency delta | 2 tests |
| A21 guard-disable sanity | manual exercise (first round only), recorded above; Rev107's two new guards are self-proving by A18/F2 |
| duplicate `routeRef` throws | 1 test |

## Validation

- `npx tsc --noEmit`: clean (including `exactOptionalPropertyTypes` compliance).
- Clean rebuild discipline (per the V5X-CAP-001 finding that `npm run build` does not clean `dist/` first): `rm -rf dist && npm run build`, then `node --test dist/tests/*.test.js`.
- Result: **740/740 tests pass** (708 pre-existing on `main@3226c76fa338e425e553638e5f5f48924182a1c0` + 32 in `project-activation-profile.test.ts`). Zero regressions, zero skips.
- First-round A21 guard-disable sanity performed and reverted as described above; full suite re-confirmed green after restore. Second-round (Rev107) guards are self-proving by their own ordinary adversarial tests.

## Status

`IMPLEMENTED / SELF-VALIDATED`. Per `AGENTS.md` §10 and this repository's `CLAUDE.md`, Claude's authority ends here. This second correction addresses every Rev107 finding (F1-F3) on top of the already-resolved Rev104 findings; it stays **OPEN/DRAFT/HOLD_MERGE** on PR #101 pending independent Brain re-review of the new exact head. No merge, no MAIN mutation.
