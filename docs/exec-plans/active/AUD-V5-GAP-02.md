# AUD-V5-GAP-02 — Commercial Order → Declared Service/Recipe Lookup (Cold-Start floor)

> **Rev79 terminology note**: this task's original title/Goal/Scope/invariant wording (below) predates the Rev77 API rename and used "canonical" language throughout, matching the identifiers that existed at the time. The code was renamed under Rev77 (`CanonicalServiceResolution` → `DeclaredServiceLookupResult`, `resolveCanonicalServiceFromOrder` → `resolveDeclaredServiceFromOrder`); this Rev79 pass brings the surrounding current task-record wording into line with that rename so the *current* framing is provenance-honest throughout, not just the identifiers. Quoted historical text below (Brain's own Rev62/Rev74/Rev77 verbatim findings, in quotation marks) is preserved unchanged as history — only this document's own non-quoted, current-tense description is reworded.

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor; Brain's Rev62 Handoff, "AUD-V5-GAP-02 — WEBSITE BUILD COLD-START NORTH-STAR NOT YET END-TO-END PROVEN — CARRIED FORWARD FROM REV60" and the Handoff's own "AUTHORIZED CORRECTION ORDER — NO FOUNDER RELAY" step 3 continuation note: *"After F1 closes, fresh dependency scan the V5 Cold-Start gap. The smallest likely next convergence slice is Commercial Order → Canonical Service/Recipe Resolution → Conditional Intake/Readiness, reusing existing repo primitives and creating no second orchestration system."*
- **Selection reasoning**: F1 (`AUD-V5-01`, worker-candidate authority fail-open on malformed `authorityLevel`) closed via PR #25, merged into `main` at `fe2cbc02f20e800b309e127288cc32a72176c109` per Brain Rev70's explicit merge authorization (independently confirmed live via GitHub: PR #25 `merged: true`, that commit is current `main`'s tip). This checkpoint's own step-3 continuation is therefore live-authorized without further Founder relay. Independently re-read the Rev62 Handoff's "V5 COLD-START NORTH-STAR COMPLETION AUDIT" section before selecting this slice (not accepted from a chat paraphrase): it lists "Commercial Order → Canonical Service Resolution: MISSING on audited main; no Commercial Order start/resolver found" as the first, most upstream gap in the chain — the current `WEBSITE_BUILD_v1` proof "starts from preconstructed tenant/customer/project/soldScope/evidence... therefore is not the required zero-history commercial-order cold start." This checkpoint targets exactly that first gap and no further — "Conditional Intake/Readiness" wiring (the next link in Brain's named chain) is explicitly deferred, not silently absorbed (see "Explicitly deferred" below), matching this corridor's established narrowing-disclosure discipline (e.g. `V4-SVC-001`'s "floor only" narrowing).
- Independent of PR #30 (`AUD-DURABILITY-GAP`) and PR #31 (`V5-PTN-001` Rev62 non-blocking hardening) — cut from the identical base, touches none of their files.
- Branch: `claude/v5-cold-start-commercial-order-resolution`, cut fresh from merged `main`.
- `BASE_PROVENANCE_SHA`: `fe2cbc02f20e800b309e127288cc32a72176c109` (merged main, PR #25 — same base as PR #30/#31).

## Goal

Provide the missing first edge of the V5 Cold-Start First Customer chain: a pure, deterministic lookup from a customer's zero-history `CommercialOrder` (no `Project`, `SoldScope`, or evidence exists yet) to the specific `OfferBlueprintVersion` + `DeliveryRecipe` a caller-supplied catalog declares for it — without fabricating a real commerce/payment/pricing system, and without duplicating or bypassing any existing plan-compilation/readiness machinery. This is a **declared/caller-supplied lookup**, not canonical/trusted resolution — see "Explicitly deferred" below for the open canonical-resolution provenance gap this checkpoint does not close.

## Scope (this checkpoint)

- `src/domain/commercial-order.ts`:
  - `CommercialOrder` — `tenantId` + `customerId` + `orderId` + opaque `serviceRef` + `placedAt`. Deliberately has **no** `projectId` field: a project does not exist yet at order time — this is the genuine zero-history starting point Brain's audit found missing. No price/discount/payout/commission field exists on the type (DEC-146/153 discipline, same restraint already applied to `commercial-authority.ts`).
  - `createCommercialOrder(input)` — fail-closed construction (non-empty `orderId`/`serviceRef`/`placedAt`; `customer.tenantId` must match the given `tenantScope`, same T2/RG-01 pattern as `createProject`/`createSoldScope`).
  - `ServiceCatalogEntry` — a caller-declared `{ serviceRef, blueprintId, blueprintVersion, recipeId }` mapping. Not a real service/product/SKU system (none exists in this repository) — reuses the existing `OfferBlueprintVersion`/`DeliveryRecipe` identifiers verbatim rather than inventing a parallel concept.
  - `resolveDeclaredServiceFromOrder(order, catalog)` — pure function. Returns `{ status: "RESOLVED", blueprintId, blueprintVersion, recipeId }` when exactly one catalog entry declares the order's `serviceRef`; returns `{ status: "UNRESOLVED_SERVICE", reason }` (never a fabricated "closest" match) when none does; throws `InvalidCommercialOrderError` when more than one catalog entry declares the same `serviceRef` (ambiguous catalog is a caller/data-integrity defect — same "throw rather than guess" discipline as `resolveCurrentOwner`, V3-OWN-001). `RESOLVED` proves only that the caller's own catalog declares exactly one entry for the `serviceRef` — not that the entry is admitted/trusted (see "Explicitly deferred" below).
- `src/fixtures/website-build-v1-commercial-order.ts`: `WEBSITE_BUILD_V1_SERVICE_CATALOG` (one entry, reusing `WEBSITE_BUILD_V1_BLUEPRINT`/`WEBSITE_BUILD_V1_RECIPE` verbatim) + `buildWebsiteBuildV1CommercialOrderFixture()`, a genuine zero-history fixture: only a `TenantScope`, `Customer`, `CommercialOrder`, and its `DeclaredServiceLookupResult` — no `Project`/`SoldScope`/evidence constructed alongside it, proving this edge does not require or presuppose downstream state.

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
- **Canonical/trusted service-resolution provenance** (Rev74/Rev77): `resolveDeclaredServiceFromOrder` proves only that a caller-supplied catalog declares exactly one entry for the order's `serviceRef` — it does not prove that entry was ever admitted through a trusted, repository-native boundary. No admitted/trusted catalog authority primitive exists anywhere in this repository to bind to; inventing one would be exactly the "second catalog/orchestration system" Brain's own acceptance forbids. This gap remains **explicitly OPEN**, not closed by this checkpoint or its corrections.

## Architecture / semantic invariants (verified by test)

- A `CommercialOrder` cannot be constructed with a customer from a different tenant than the given `tenantScope` (fail-closed, same T2/RG-01 pattern already proven elsewhere).
- A `CommercialOrder` carries exactly five fields (`tenantId`, `customerId`, `orderId`, `serviceRef`, `placedAt`) — no price/discount/payout/commission field can exist on it, verified by an explicit key-set assertion.
- `resolveDeclaredServiceFromOrder` never substitutes a different `serviceRef`'s catalog entry for an unmatched order (no silent nearest-match fallback).
- An empty catalog, or a catalog with no matching `serviceRef`, resolves the honest `UNRESOLVED_SERVICE` disposition — never an error, never a guess.
- A catalog with more than one entry declaring the same `serviceRef` throws rather than picking either nondeterministically.
- A caller-fabricated catalog entry (never admitted anywhere) resolves `RESOLVED` exactly like a real one — this is the disclosed declared/caller-supplied lookup boundary, not a defect (see "Explicitly deferred").
- The `WEBSITE_BUILD_v1` order fixture is a genuine zero-history object graph (`tenantScope`, `customer`, `order`, `resolution` only — no `Project`/`SoldScope` field exists on it) that still resolves `RESOLVED` against the declared blueprint/recipe identifiers.

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
| `WEBSITE_BUILD_v1` zero-history order fixture resolves `RESOLVED` against the declared blueprint/recipe | end-to-end reference proof |
| `WEBSITE_BUILD_v1` order fixture carries no Project/SoldScope — a genuine zero-history order | proves the Cold-Start starting point is real, not presupposed |
| `WEBSITE_BUILD_V1_SERVICE_CATALOG` declares exactly one entry, reusing the existing blueprint/recipe identifiers verbatim | no parallel product/SKU concept invented |

## Evidence

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, strict mode, zero errors, clean rebuild.
- `node --test dist/tests/*.test.js`: **729/729 pass** (705 pre-existing on this base + 13 resolution tests + 9 intake tests + 2 admission-chain tests), 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/`: exactly 6 new files (`src/domain/commercial-order.ts`, `src/domain/commercial-order-intake.ts`, `src/fixtures/website-build-v1-commercial-order.ts`, `tests/commercial-order.test.ts`, `tests/commercial-order-intake.test.ts`, `tests/commercial-order-cold-start-admission.test.ts`), 825 insertions, 0 deletions/modifications to any existing file.
- `git diff origin/main -- package.json package-lock.json`: empty — zero new dependency introduced.

## Status

**SUPERSEDED by the Rev74 correction below.** Original submission (exact head `d2cd161e6c41bfed884fdd9feb894383ebd49271`) was `IMPLEMENTED / SELF-VALIDATED`, pending Brain independent exact-head review.

## Rev74 correction (Brain CHANGES_REQUIRED, exact head `d2cd161e6c41bfed884fdd9feb894383ebd49271`)

Brain independently reviewed the exact head above and returned `CHANGES_REQUIRED` on the Commercial Order → Canonical Service Resolution slice:

- **F1 BLOCKING** (verbatim): *"resolveCanonicalServiceFromOrder accepts caller-supplied ServiceCatalogEntry[] without admission/provenance/authority binding. A caller can fabricate serviceRef → blueprint/version/recipe and obtain RESOLVED. This is deterministic caller-supplied lookup, not canonical resolution."*
- **Acceptance** (verbatim): *"bind resolution to an existing admitted/trusted repository-native catalog authority/provenance boundary and add a forged/unadmitted mapping negative test; OR narrow the claim honestly to deterministic caller-supplied lookup and leave the canonical-resolution audit gap OPEN. Do not create a second catalog/orchestration system."*

**Which acceptance path, and why**: a repository-wide search was run before choosing (`grep -rl` for `OfferBlueprintVersion`/`DeliveryRecipe` usage, and separately for any `ServiceCatalog`/catalog-admission naming anywhere in `src/`). No admitted/trusted catalog authority or provenance primitive exists anywhere in this codebase. The closest candidates — `OfferBlueprintVersion` (`src/domain/offer-blueprint.ts`) and `DeliveryRecipe` (`src/domain/delivery-recipe.ts`) — are validated-*construction* domain objects (their factory functions reject dangling/inconsistent references at creation time) with no admission, review, or trust-provenance concept layered on top; there is nothing resembling `partner-capability-admission.ts`'s `admitPartnerCapabilityClaim` for service catalog entries. Building one here to satisfy the "bind to an admitted/trusted boundary" path would itself be the "second catalog/orchestration system" the acceptance explicitly forbids. The honest-narrowing path was therefore selected.

**Fix**: `commercial-order.ts`'s doc comments on `ServiceCatalogEntry`, `CanonicalServiceResolution`, and `resolveCanonicalServiceFromOrder` were rewritten to state plainly that `RESOLVED` proves only that the caller's own catalog declares exactly one entry for the order's `serviceRef` — it is **not** proof of canonical/trusted resolution, since nothing checks the entry against any admitted source. The real canonical-resolution audit gap (binding catalog entries to a trusted, repository-native provenance boundary) is recorded as **explicitly OPEN**, not silently closed. A new test in `tests/commercial-order.test.ts` ("Rev74 F1 (honest boundary disclosure)") demonstrates the disclosed boundary directly: a caller-fabricated catalog entry (a `serviceRef` never admitted anywhere, paired with arbitrary forged `blueprintId`/`blueprintVersion`/`recipeId` strings) resolves `RESOLVED` exactly as a real entry would — proving the limitation is real and documented by a passing test, not just prose.

No production behavior changed (the resolver's logic was already exactly what the doc comments now honestly describe) — this is a claim-boundary correction, not a behavior fix, consistent with Brain's own "narrow the claim" acceptance option.

### New exact head

New head (this branch, `claude/v5-cold-start-commercial-order-resolution`, post-merge-with-`main` + F1 doc/test correction): see `git log -1` at time of push. Base is now `main` at `3226c76fa338e425e553638e5f5f48924182a1c0` (post-PR#31-merge), reachable via the merge commit's second parent.

## Evidence (Rev74 correction)

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, strict mode, zero errors, clean rebuild.
- `node --test dist/tests/*.test.js`: **733/733 pass** (708 pre-existing on the new `main` base + 24 pre-existing AUD-V5-GAP-02 tests + 1 new disclosure test), 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/` (against the new `main`, post-PR#31-merge): 6 files touched (all new, unchanged file list from the original submission), 890 insertions, 0 deletions.
- `git diff origin/main -- package.json package-lock.json`: empty — zero new dependency introduced.

## Status

**SUPERSEDED by the Rev77 correction below.** Rev74-corrected submission (exact head `07968abbff73127d223f2eccfbe4bd7c15712cc1`) was `IMPLEMENTED / SELF-VALIDATED`, pending Brain independent exact-head review.

## Rev77 correction (Brain CHANGES_REQUIRED, exact head `07968abbff73127d223f2eccfbe4bd7c15712cc1`)

Brain independently reviewed the Rev74-corrected head and returned `CHANGES_REQUIRED`, verbatim: *"Behavioral narrowing is honest, but the new public contract still embeds the disproven canonical claim in names such as `CanonicalServiceResolution` and `resolveCanonicalServiceFromOrder` while explicitly admitting the lookup is caller-supplied and untrusted. REQUIRED CORRECTION: rename the public API and task wording to provenance-honest declared/caller-catalog lookup semantics; retain canonical-resolution provenance as explicitly OPEN. No new catalog/orchestration system required."*

**Diagnosis, confirmed against source**: the Rev74 correction fixed the *claim* (doc comments honestly stated `RESOLVED` proves only caller-supplied lookup, not canonical resolution) but left the *identifiers themselves* unchanged. A reader importing `CanonicalServiceResolution` or calling `resolveCanonicalServiceFromOrder` sees "canonical" in the type signature at every call site, regardless of what the doc comment beside the declaration says — the name itself keeps making the disproven claim independent of the prose.

**Fix**: renamed the public API, naming-only, no behavior change:

- `CanonicalServiceResolution` → `DeclaredServiceLookupResult`
- `resolveCanonicalServiceFromOrder` → `resolveDeclaredServiceFromOrder`

Applied consistently across `src/domain/commercial-order.ts`, `src/domain/commercial-order-intake.ts`, `src/fixtures/website-build-v1-commercial-order.ts`, `tests/commercial-order.test.ts`, `tests/commercial-order-intake.test.ts`. The `ServiceCatalogEntry` doc comment's stray use of "canonical" to describe the blueprint/recipe pointer (not the resolution's trustworthiness) was also softened to "specific" to avoid any residual ambiguity. The `"RESOLVED"`/`"UNRESOLVED_SERVICE"` status literals were left unchanged — Brain's finding named the two specific identifiers above, and those literals carry no canonical/trust claim of their own. The canonical-resolution audit gap remains recorded as explicitly OPEN, exactly as the Rev74 correction left it — this correction only fixes the naming, not the underlying scope.

### New exact head

New head (this branch, `claude/v5-cold-start-commercial-order-resolution`, post-Rev74-correction + Rev77 rename): see `git log -1` at time of push. Base remains `main` at `3226c76fa338e425e553638e5f5f48924182a1c0` (unchanged from the Rev74 correction — no further reconciliation needed).

## Evidence (Rev77 correction)

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, strict mode, zero errors, clean rebuild.
- `node --test dist/tests/*.test.js`: **733/733 pass** (unchanged from the Rev74-corrected head — pure rename, zero behavior change, zero new/removed test), 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/`: 6 files touched (unchanged file list), 901 insertions, 0 deletions.
- `git diff origin/main -- package.json package-lock.json`: empty — zero new dependency introduced.
- `grep -rn "CanonicalServiceResolution\|resolveCanonicalServiceFromOrder" src/ tests/`: zero matches (confirmed no stray reference to the old names remains anywhere in source or tests).

## Status

**SUPERSEDED by the Rev79 correction below.** Rev77-corrected submission (exact head `829c56d69f3a4f2d96896753fcf9cf17d04f0156`) was `IMPLEMENTED / SELF-VALIDATED`, pending Brain independent exact-head review.

## Rev79 correction (Brain CHANGES_REQUIRED — NARROW SEMANTIC CLEANUP ONLY, exact head `829c56d69f3a4f2d96896753fcf9cf17d04f0156`)

Brain independently reviewed the Rev77-corrected head and returned `CHANGES_REQUIRED`, verbatim: *"The TypeScript public API correction is accepted: CanonicalServiceResolution was renamed to DeclaredServiceLookupResult and resolveCanonicalServiceFromOrder to resolveDeclaredServiceFromOrder, with zero intended behavior change and canonical/trusted provenance still OPEN. Remaining blocker: the active repo task record docs/exec-plans/active/AUD-V5-GAP-02.md still presents its current title/Goal/Scope/invariants/test wording as 'Canonical Service/Recipe Resolution' and still names the old API in current sections; the live PR title/current framing also still carries 'Canonical Resolution'. REQUIRED CORRECTION: make the current task/PR framing provenance-honest Declared Service/Recipe Lookup terminology, update current non-historical old-identifier mentions, and preserve historical quoted/superseded findings as history."*

**Confirmed**: the Rev77 code/API rename itself was already accepted — no further source or test change is needed or was made. The gap was purely in this document's own top-level framing (title, Goal, Scope, Architecture/semantic invariants, Test Coverage table), which predated the Rev77 rename and had never been updated to match it, plus the live PR's own title/summary.

**Fix (docs/framing-only, zero behavior change)**:
- This document's title, Goal, Scope, and Architecture/semantic invariants sections reworded from "canonical resolution" framing to "declared/caller-supplied lookup" framing, and updated to reference `resolveDeclaredServiceFromOrder`/`DeclaredServiceLookupResult` instead of the old identifiers.
- The "Explicitly deferred" section now explicitly names the canonical/trusted service-resolution provenance gap as OPEN (it previously only implied this via the general "no real service/product catalog" bullet).
- The Test Coverage table's two remaining "canonical" mentions (describing the blueprint/recipe fixture, not the resolution's trustworthiness) reworded to "declared"/"existing" respectively.
- Historical quoted text — Brain's own Rev62/Rev74/Rev77 verbatim findings, and the "Rev74/Rev77 correction" section headers themselves — preserved unchanged, per Brain's own instruction that clearly-labeled historical/superseded quotations may retain old names.
- PR #32's title and description on GitHub updated to match (see PR itself for current text).

No production behavior changed — this is the second half of the Rev77 rename's own completeness (code was renamed; the surrounding task-record prose is now renamed to match). Canonical/trusted service-resolution provenance remains recorded as explicitly OPEN, unchanged from Rev74/Rev77.

### New exact head

New head (this branch, `claude/v5-cold-start-commercial-order-resolution`, post-Rev77-rename + Rev79 doc/framing correction): see `git log -1` at time of push. Base remains `main` at `3226c76fa338e425e553638e5f5f48924182a1c0` (unchanged — no further reconciliation needed).

## Evidence (Rev79 correction)

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, strict mode, zero errors, clean rebuild.
- `node --test dist/tests/*.test.js`: **733/733 pass** (unchanged — docs-only correction, zero behavior change, zero new/removed test), 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/`: unchanged from the Rev77-corrected head (this correction touches only `docs/exec-plans/active/AUD-V5-GAP-02.md` and the PR's own title/description on GitHub, neither of which is `src/`/`tests/`).
- `git diff origin/main -- package.json package-lock.json`: empty — zero new dependency introduced.
- Confirmed current (non-historical) task-record wording is provenance-honest: every non-quoted mention of "canonical" in this document's title/Goal/Scope/Architecture/Test-Coverage sections has been reworded; the only remaining "canonical"/old-identifier mentions in this file are inside explicitly historical, quoted, or clearly-labeled-superseded sections (Provenance's direct Handoff quotes, the "Rev74 correction"/"Rev77 correction" section headers and their own historical prose).

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain independent exact-head review of the new head. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant.
