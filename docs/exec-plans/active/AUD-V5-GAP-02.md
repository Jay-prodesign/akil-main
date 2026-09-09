# AUD-V5-GAP-02 — Commercial Order → Canonical Service/Recipe Resolution (Cold-Start floor)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor; Brain's Rev62 Handoff, "AUD-V5-GAP-02 — WEBSITE BUILD COLD-START NORTH-STAR NOT YET END-TO-END PROVEN — CARRIED FORWARD FROM REV60" and the Handoff's own "AUTHORIZED CORRECTION ORDER — NO FOUNDER RELAY" step 3 continuation note: *"After F1 closes, fresh dependency scan the V5 Cold-Start gap. The smallest likely next convergence slice is Commercial Order → Canonical Service/Recipe Resolution → Conditional Intake/Readiness, reusing existing repo primitives and creating no second orchestration system."*
- **Selection reasoning**: F1 (`AUD-V5-01`, worker-candidate authority fail-open on malformed `authorityLevel`) closed via PR #25, merged into `main` at `fe2cbc02f20e800b309e127288cc32a72176c109` per Brain Rev70's explicit merge authorization (independently confirmed live via GitHub: PR #25 `merged: true`, that commit is current `main`'s tip). This checkpoint's own step-3 continuation is therefore live-authorized without further Founder relay. Independently re-read the Rev62 Handoff's "V5 COLD-START NORTH-STAR COMPLETION AUDIT" section before selecting this slice (not accepted from a chat paraphrase): it lists "Commercial Order → Canonical Service Resolution: MISSING on audited main; no Commercial Order start/resolver found" as the first, most upstream gap in the chain — the current `WEBSITE_BUILD_v1` proof "starts from preconstructed tenant/customer/project/soldScope/evidence... therefore is not the required zero-history commercial-order cold start." This checkpoint targets exactly that first gap and no further — "Conditional Intake/Readiness" wiring (the next link in Brain's named chain) is explicitly deferred, not silently absorbed (see "Explicitly deferred" below), matching this corridor's established narrowing-disclosure discipline (e.g. `V4-SVC-001`'s "floor only" narrowing).
- Independent of PR #30 (`AUD-DURABILITY-GAP`) and PR #31 (`V5-PTN-001` Rev62 non-blocking hardening) — cut from the identical base, touches none of their files.
- Branch: `claude/v5-cold-start-commercial-order-resolution`, cut fresh from merged `main`.
- `BASE_PROVENANCE_SHA`: `fe2cbc02f20e800b309e127288cc32a72176c109` (merged main, PR #25 — same base as PR #30/#31).

## Goal

Provide the missing first edge of the V5 Cold-Start First Customer chain: a pure, deterministic resolver from a customer's zero-history `CommercialOrder` (no `Project`, `SoldScope`, or evidence exists yet) to the canonical `OfferBlueprintVersion` + `DeliveryRecipe` that fulfills it — without fabricating a real commerce/payment/pricing system, and without duplicating or bypassing any existing plan-compilation/readiness machinery.

## Scope (this checkpoint)

- `src/domain/commercial-order.ts`:
  - `CommercialOrder` — `tenantId` + `customerId` + `orderId` + opaque `serviceRef` + `placedAt`. Deliberately has **no** `projectId` field: a project does not exist yet at order time — this is the genuine zero-history starting point Brain's audit found missing. No price/discount/payout/commission field exists on the type (DEC-146/153 discipline, same restraint already applied to `commercial-authority.ts`).
  - `createCommercialOrder(input)` — fail-closed construction (non-empty `orderId`/`serviceRef`/`placedAt`; `customer.tenantId` must match the given `tenantScope`, same T2/RG-01 pattern as `createProject`/`createSoldScope`).
  - `ServiceCatalogEntry` — a caller-declared `{ serviceRef, blueprintId, blueprintVersion, recipeId }` mapping. Not a real service/product/SKU system (none exists in this repository) — reuses the existing `OfferBlueprintVersion`/`DeliveryRecipe` identifiers verbatim rather than inventing a parallel concept.
  - `resolveCanonicalServiceFromOrder(order, catalog)` — pure function. Returns `{ status: "RESOLVED", blueprintId, blueprintVersion, recipeId }` when exactly one catalog entry declares the order's `serviceRef`; returns `{ status: "UNRESOLVED_SERVICE", reason }` (never a fabricated "closest" match) when none does; throws `InvalidCommercialOrderError` when more than one catalog entry declares the same `serviceRef` (ambiguous catalog is a caller/data-integrity defect — same "throw rather than guess" discipline as `resolveCurrentOwner`, V3-OWN-001).
- `src/fixtures/website-build-v1-commercial-order.ts`: `WEBSITE_BUILD_V1_SERVICE_CATALOG` (one entry, reusing `WEBSITE_BUILD_V1_BLUEPRINT`/`WEBSITE_BUILD_V1_RECIPE` verbatim) + `buildWebsiteBuildV1CommercialOrderFixture()`, a genuine zero-history fixture: only a `TenantScope`, `Customer`, `CommercialOrder`, and its `CanonicalServiceResolution` — no `Project`/`SoldScope`/evidence constructed alongside it, proving this edge does not require or presuppose downstream state.

## Extension: Conditional Intake + compiled-plan Readiness (same branch, same checkpoint)

Continuing the same corridor loop immediately (same "smallest likely next convergence slice" Brain named as one unit — "Commercial Order → Canonical Service/Recipe Resolution → Conditional Intake/Readiness"): closes the second and third named gaps.

- `src/domain/commercial-order-intake.ts` (new): `intakeSoldScopeFromResolution(input)` — the Cold-Start audit's own exact words for this gap: *"Conditional Intake: PARTIAL; sold-scope/evidence/blueprint primitives exist but no order-driven intake compiler."* Fails closed (`InvalidCommercialOrderIntakeError`) unless `resolution.status === "RESOLVED"` and the supplied `blueprint`'s `blueprintId`/`version` exactly match the order's own resolved `blueprintId`/`blueprintVersion` — the missing binding between "what the order resolved to" and "what SoldScope gets built." Delegates entirely to the already-verified `createSoldScope` for everything else; no sold-scope construction logic duplicated.
- `src/fixtures/website-build-v1-commercial-order.ts` extended with `buildWebsiteBuildV1ColdStartFixture()`: proves the full chain end to end from one zero-history order — order → resolution → intake-compiled `SoldScope` (fail-closed bound to the resolved blueprint) → `compilePlan` → `validatePlan` returning `COMPLETE` ("Brief Completeness / Readiness" — the audit's `PARTIAL end-to-end` finding). Project creation is deliberately direct (not bootstrap-template-driven — `project-bootstrap-template.ts`/V5-BOOT-001 stays a separate, untouched concern) to isolate this chain from bootstrap-template composition, which remains future work.
- `tests/commercial-order-intake.test.ts` (new): 9 tests — positive intake, field forwarding, `UNRESOLVED_SERVICE` rejection, blueprint-identity mismatch rejection, blueprint-version mismatch rejection, tenant-mismatch delegation, and three fixture-level end-to-end proofs (chain succeeds, plan independently re-validates `COMPLETE`, catalog/blueprint version consistency).

## Extension 2: Required Approval → ADMITTED plan → wired DRAFT OutcomeJobs (same branch, same checkpoint)

Continuing the same loop again immediately (per the corridor's own rule that a pending Brain review does not justify idling while another safe path exists): closes the audit's *"Required Approval: PRESENT primitive / PARTIAL end-to-end"* finding, and begins (without completing) *"Delivery Closure."*

- `tests/commercial-order-cold-start-admission.test.ts` (new): composes only existing, separately-tested primitives — `createApprovalReference`, `buildFullReadinessAssertions` (the existing test helper already used by `tests/outcome-job-wiring.test.ts`'s own T1), `admitPlan`, `deriveOutcomeJobSpecs`, `admitJobs`, `wireAdmittedOutcomeJobs` — on top of the same zero-history `buildWebsiteBuildV1ColdStartFixture()`'s `plan`. Proves: given a valid `ApprovalReference` bound to the exact compiled plan and full readiness evidence for every `REQUIRED` node, the plan admits `ADMITTED`, every derived job admits `ADMITTED`, and `wireAdmittedOutcomeJobs` produces one `DRAFT` `OutcomeJob` per spec, correctly tenant/project/customer-scoped. A second test proves the negative: with no approval supplied, the same chain stays `WAITING` and wires zero jobs.
- No new production source file — this extension is proof-by-composition only, using primitives already shipped and tested elsewhere in the corridor (`plan-admission.ts`, `outcome-job-spec.ts`, `outcome-job-wiring.ts`, `approval-reference.ts`). Nothing about their behavior is changed.
- Deliberately stops at `DRAFT` `OutcomeJob`s: actual execution, worker routing invocation, QA/evidence capture, and handover/verification ("Delivery Closure" proper) all require real worker/effect capability this repository does not have — same restraint already applied to V4 Workstreams C-H. This is **not** claimed as closing "Delivery Closure"; only as proving the chain reaches a genuinely admitted, job-wired state from a zero-history order.

## Explicitly deferred (not invented)

- **Evidence-based admission readiness** is now proven reachable (Extension 2 above) — but the readiness evidence itself remains caller-supplied test fixture data, not a real customer-evidence-capture system. No customer evidence is fabricated as if it came from a real customer interaction.
- **Actual job execution / worker routing invocation / QA-evidence capture / handover / verification** ("Delivery Closure" proper, and "Authorized Execution") remain out of scope — no real provider/effect/worker capability exists in this repository (same restraint as V4 Workstreams C-H). Jobs are proven to reach `DRAFT`, never further.
- **Project/repository bootstrap from a resolved order** is not wired here — `project-bootstrap-template.ts` (V5-BOOT-001) remains a separate, already-tested concern; composing them is future work, not fabricated in this checkpoint.
- No real commerce/payment/checkout/order-management system, no numeric/currency field, no discount/commission/payout value — none exists anywhere in this repository (DEC-146/153).
- No real service/product catalog persistence or lookup service — the catalog is a plain caller-supplied array, matching every other domain module's "no persistence/network/filesystem coupling" pattern.

## Architecture / semantic invariants (verified by test)

- A `CommercialOrder` cannot be constructed with a customer from a different tenant than the given `tenantScope` (fail-closed, same T2/RG-01 pattern already proven elsewhere).
- A `CommercialOrder` carries exactly five fields (`tenantId`, `customerId`, `orderId`, `serviceRef`, `placedAt`) — no price/discount/payout/commission field can exist on it, verified by an explicit key-set assertion.
- `resolveCanonicalServiceFromOrder` never substitutes a different `serviceRef`'s catalog entry for an unmatched order (no silent nearest-match fallback).
- An empty catalog, or a catalog with no matching `serviceRef`, resolves the honest `UNRESOLVED_SERVICE` disposition — never an error, never a guess.
- A catalog with more than one entry declaring the same `serviceRef` throws rather than picking either nondeterministically.
- The `WEBSITE_BUILD_v1` order fixture is a genuine zero-history object graph (`tenantScope`, `customer`, `order`, `resolution` only — no `Project`/`SoldScope` field exists on it) that still resolves `RESOLVED` against the canonical blueprint/recipe identifiers.

## Hard Non-Scope

No filesystem/network/child_process import anywhere in `commercial-order.ts` or `commercial-order-intake.ts` (sibling domain-module imports only, all type-only except the direct delegation to `createSoldScope`). No provider/model hard-coding. No secret/credential material. No execution of the resolved recipe/plan. No merge/deploy/release/production/publication/customer-binding/legal/financial action anywhere in this checkpoint's source.

## Test Coverage

All in `tests/commercial-order.test.ts`:

| Test | Acceptance direction | 
|---|---|
| Creates a `CommercialOrder` bound to the given tenant/customer | basic construction |
| Carries no price/discount/payout/commission field | DEC-146/153 discipline, structurally enforced |
| Rejects a customer from a different tenantScope | T2/RG-01 fail-closed |
| Rejects an empty/whitespace-only `orderId` | input validation |
| Rejects an empty `serviceRef` | input validation |
| Resolves a `serviceRef` present in the catalog | positive resolution path |
| Returns `UNRESOLVED_SERVICE` (never a fabricated closest match) for an unknown `serviceRef` | fail-closed, honest disposition |
| Returns `UNRESOLVED_SERVICE` against an empty catalog | fail-closed, honest disposition |
| Throws (never guesses) on an ambiguous catalog with a duplicate `serviceRef` | "throw rather than guess" discipline |
| Never substitutes a different `serviceRef`'s catalog entry | cross-service substitution rejected |
| `WEBSITE_BUILD_v1` zero-history order fixture resolves `RESOLVED` against the canonical blueprint/recipe | end-to-end reference proof |
| `WEBSITE_BUILD_v1` order fixture carries no Project/SoldScope — a genuine zero-history order | proves the Cold-Start starting point is real, not presupposed |
| `WEBSITE_BUILD_V1_SERVICE_CATALOG` declares exactly one entry, reusing canonical identifiers verbatim | no parallel product/SKU concept invented |

## Evidence

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, strict mode, zero errors, clean rebuild.
- `node --test dist/tests/*.test.js`: **729/729 pass** (705 pre-existing on this base + 13 resolution tests + 9 intake tests + 2 admission-chain tests), 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/`: exactly 6 new files (`src/domain/commercial-order.ts`, `src/domain/commercial-order-intake.ts`, `src/fixtures/website-build-v1-commercial-order.ts`, `tests/commercial-order.test.ts`, `tests/commercial-order-intake.test.ts`, `tests/commercial-order-cold-start-admission.test.ts`), 825 insertions, 0 deletions/modifications to any existing file.
- `git diff origin/main -- package.json package-lock.json`: empty — zero new dependency introduced.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant.
