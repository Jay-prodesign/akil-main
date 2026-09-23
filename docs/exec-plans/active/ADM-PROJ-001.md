# ADM-PROJ-001 — Project Activation / Effective Execution Profile

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor; Brain/AKILTA Brain AA-005 ("AKILTA — Current Engineering Handoff") Rev99/100/101, which specify a bounded, non-production compiler task composing this repository's existing project-lifecycle primitives (`SoldScope`, `ProjectPlanVersion`/`admitPlan`, `ConnectionAuthority`/`CapabilityAdmission`, `resolveWorkerRoute`, `wireAdmittedOutcomeJobs`) into one versioned `ProjectActivationProfile` readiness verdict, without introducing any new persistence, identity, billing, or runtime surface.
- **Selection reasoning**: with PR #63 (`claude/authority-migration-001`) held explicitly per Founder instruction pending Brain Rev83's F1/F2 corrections, and V5X-CAP-001 (PR #100) independently closed PASS/VERIFIED by Brain Rev98, a fresh read of AA-005 found Rev99-101 progressively de-risking and fully specifying ADM-PROJ-001 as the next dependency-safe, non-production engineering unit — explicitly independent of the held authority-migration edge. The Founder's own standing instruction in this session ("continue execution without waiting for another 'devam' prompt unless you encounter a genuine Founder decision, authority conflict, destructive action, credential/access blocker, or a canonical contradiction") was given for the V5X-CAP-001 lane; no equivalent contradiction, blocker, or conflict was found for ADM-PROJ-001 either, so — consistent with this repository's `CLAUDE.md` "don't idle-wait on Brain" standing habit and the exhaustive de-risking already recorded in AA-005 — engineering proceeded rather than issuing a further, purely repetitive confirmation request.
- Branch: `claude/adm-proj-001-project-activation-profile`, cut fresh from `main`.
- `BASE_PROVENANCE_SHA`: `3226c76` (independently re-verified against `origin/main` immediately before implementation and again immediately before this record).

## Goal

Compile a `ProjectActivationProfile`: a pure, deterministic readiness verdict for turning an accepted commercial scope into admitted, wired `OutcomeJob`s, built entirely by composing existing repository primitives — no new domain concept duplicates an existing one, and no HTTP/persistence/runtime/UI surface is introduced.

## Scope (this checkpoint)

- `src/domain/project-activation-profile.ts`:
  - `AcceptedCommercialReference` / `createAcceptedCommercialReference` / `isCommercialReferenceValidForSoldScope` — the commercial-acceptance gate, structurally mirroring `approval-reference.ts`'s `ApprovalReference`/`hashPlanPayload`/`isApprovalValidForPlan` pattern (a deterministic SHA-256 content digest binding the reference to the exact `SoldScope` it was accepted against), but for the pre-plan commercial scope rather than the compiled plan.
  - `ActivationActor` (`NONE` | `CUSTOMER` | `AKILTA` | `HUMAN_REVIEW`), `ActivationState` (`READY` | `BLOCKED` | `WAITING`), `MaterialPlatformDecision` (exact kind + reason + optional related ref — never a generic placeholder, matching `PlanValidationFinding`/`AdmissionAwaiting`/`ReadinessGap`'s existing discipline).
  - `ActivationWorkerRouteInput` — a caller-supplied `routeRef` paired with a `WorkerRoutingRequest`, since the routing module itself carries no request identifier.
  - `ProjectActivationProfile` — the compiled output: identity/ownership, `state`/`actor`/optional `decision`, `routingDecisions`, `wiredJobs`, a deterministic `sourceFingerprint` (SHA-256, same technique as `hashPlanPayload`), and `compiledAt`.
  - `compileProjectActivationProfile(input)` — pure function, nine-step fail-closed validation order (full detail in the function's own doc comment):
    1. Structural coherence (`customer`/`project`/`soldScope`/`acceptedCommercialReference` all belong to the given `tenantScope`/`project`) — throws on mismatch, a caller-construction error, not a readiness gap.
    2. Compile the plan (`compilePlan`) — deterministic derivation, not a gate.
    3. Commercial-acceptance gate (`isCommercialReferenceValidForSoldScope`) — missing/stale → `BLOCKED`/`CUSTOMER`.
    4. Admit the plan (`admitPlan`).
    5. Interpret the `PlanAdmissionResult`: `BLOCKED` → `BLOCKED`/`AKILTA`; `WAITING` on `"plan-approval"` → `WAITING`/`HUMAN_REVIEW`; `WAITING` on a `RequirementId` (unresolved sold-scope decision) → `WAITING`/`CUSTOMER`; `ADMITTED` → continue.
    6. Derive and admit `OutcomeJobSpec`s (`deriveOutcomeJobSpecs`/`admitJobs`).
    7. Connection/capability readiness gate: every `connectionRequirements` entry whose `requiredCapabilityRef` names a `REQUIRED`-disposition plan node must have a matching `capabilityAdmissions` entry with `status === "VERIFIED_AVAILABLE"` — missing/unverified → `BLOCKED`, actor `CUSTOMER` when `accountOwner === "CUSTOMER_OWNED"`, else `AKILTA`.
    8. Worker routing (`resolveWorkerRoute` per supplied route) — a duplicate `routeRef` throws; any `REJECTED` decision → `BLOCKED`/`AKILTA`.
    9. Only once steps 1-8 are fully clean: `wireAdmittedOutcomeJobs`, `state: "READY"`, `actor: "NONE"`, no `decision`.

## Explicitly deferred (not invented)

No new persistence/durable-store module (a caller wanting a durable `ProjectActivationProfile` history follows the same wrap-with-an-idempotent-store pattern already established by `durable-plan-admission-store.ts`/`durable-outcome-job-store.ts` — not built here). No HTTP/API surface. No real provider/model/commerce API call anywhere in this module (`resolveWorkerRoute`/`ConnectionAuthority` remain the sole, already-provider-neutral boundaries this module calls through). No new worker/reviewer admission process, no new connection-verification mechanism — both are consumed exactly as already defined (`AdmittedWorker`/`ConnectionBinding`/`CapabilityAdmission`), never reinterpreted. No production/publish/deploy effect: this module never imports or calls anything beyond pure domain functions. No invented recovery/retry semantics for a `BLOCKED`/`WAITING` profile — the caller re-invokes `compileProjectActivationProfile` with updated inputs, exactly as `admitPlan` already expects for its own `BLOCKED`/`WAITING` outputs.

## Architecture / semantic invariants (verified by test)

- `compileProjectActivationProfile` never mutates or persists anything and never reads the system clock — the caller supplies `now`; identical inputs always produce an identical `ProjectActivationProfile`, `sourceFingerprint` included.
- A structurally malformed caller input (wrong tenant/customer/project/ownership binding, a `connectionRequirements` entry for a different project, a duplicate `workerRoutes` `routeRef`) always throws `InvalidProjectActivationProfileError` — it is never silently accepted or turned into a business decision.
- A stale or wrong-scope `AcceptedCommercialReference` always blocks with actor `CUSTOMER`, never silently carrying forward past a materially changed `SoldScope`.
- `PlanAdmissionResult.BLOCKED` always maps to actor `AKILTA` (a structural/dependency/readiness defect is a platform responsibility); `WAITING` on `"plan-approval"` always maps to `HUMAN_REVIEW`; `WAITING` on any other (`RequirementId`) entity always maps to `CUSTOMER`.
- A `REQUIRED`-disposition capability with no `VERIFIED_AVAILABLE` `CapabilityAdmission` always blocks, with the actor determined solely by the connection requirement's own declared `accountOwner` — never inferred, never defaulted.
- A connection requirement for a capability that is not currently `REQUIRED` under the compiled plan (an excluded/未-included `CONDITIONAL` requirement) is never gated — readiness is scoped to what is actually in play for the current sold plan.
- A `REJECTED` worker-routing decision always blocks with actor `AKILTA`, and every routing decision made before the rejecting one is preserved on the returned profile, not discarded.
- `wireAdmittedOutcomeJobs` is reachable only once every one of the eight preceding gates is clean — there is no code path that reaches `state: "READY"` any other way.

## Hard Non-Scope

No new database/identity/billing/runtime surface. No merge/deploy/release/production/publication/customer-binding/legal/financial action anywhere in this checkpoint's source. No modification to any existing domain file — every composed primitive (`project-plan.ts`, `plan-admission.ts`, `outcome-job-spec.ts`, `outcome-job-wiring.ts`, `outcome-job.ts`, `connection-authority.ts`, `capability-admission.ts`, `worker-routing-policy.ts`, `approval-reference.ts`, `sold-scope.ts`, `project-ownership.ts`) is imported and consumed exactly as it already exists, unchanged. No secret/credential material — `ConnectionRequirement`/`ConnectionBinding` continue to carry only opaque `SecretRef` ids, never raw material, per their own existing invariants. PR #63 (`claude/authority-migration-001`) is untouched by this checkpoint.

## Test Coverage

`tests/project-activation-profile.test.ts` (20 tests):

| Area | Covered by |
|---|---|
| `AcceptedCommercialReference` construction validation, exact-match validity, staleness on a materially changed `SoldScope`, mismatch on a different `soldScopeId` | 4 tests |
| Structural coherence throws (wrong tenant, foreign-project commercial reference) | 2 tests |
| Commercial-acceptance gate → `BLOCKED`/`CUSTOMER` | 1 test |
| Plan admission interpretation: `BLOCKED`→`AKILTA`, pure `WAITING`/`CUSTOMER` (no escalation to BLOCKED), `WAITING`/`HUMAN_REVIEW` on missing approval, readiness-gap `BLOCKED` preceding the approval check | 4 tests |
| Connection/capability readiness: `CUSTOMER_OWNED` vs `AKILTA_MANAGED` actor split, out-of-scope `CONDITIONAL` capability never gated, foreign-project connection requirement throws | 4 tests |
| Worker routing: `REJECTED` → `BLOCKED`/`AKILTA`, duplicate `routeRef` throws | 2 tests |
| Happy path: `READY`/`NONE`, every `REQUIRED` node wired exactly once | 1 test |
| Determinism: identical inputs → identical profile/`sourceFingerprint`; differing terminal states → differing fingerprints | 2 tests |

## Validation

- `npx tsc --noEmit`: clean (including `exactOptionalPropertyTypes` compliance).
- Clean rebuild discipline applied per the V5X-CAP-001 finding (`npm run build` does not clean `dist/` first, so a stale `dist/` from a prior branch/session can silently inflate or corrupt a test count): `rm -rf dist && npm run build`, then `node --test dist/tests/*.test.js`.
- Result: **728/728 tests pass** (708 pre-existing on `main@3226c76` + 20 new `project-activation-profile.test.ts` tests). Zero regressions, zero skips.

## Status

`IMPLEMENTED / SELF-VALIDATED`. Per `AGENTS.md` §10 and this repository's `CLAUDE.md`, Claude's authority ends here — advancing this status further (e.g. to a merge-ready verdict) requires Brain/Codex or Founder review of the exact head this record is committed against.
