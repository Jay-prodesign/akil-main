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

## Explicitly deferred (not invented)

- **Conditional Intake/Readiness wiring** (the next link in Brain's named chain) is out of scope for this checkpoint. This resolver's `RESOLVED` output (`blueprintId`/`blueprintVersion`/`recipeId`) is a plain value a future checkpoint can feed into `createSoldScope`/`compilePlan`/`evaluateReadiness` — none of that existing, separately-tested machinery is touched, duplicated, or bypassed here.
- **Project/repository bootstrap from a resolved order** is not wired here either — `project-bootstrap-template.ts` (V5-BOOT-001) remains a separate, already-tested concern; composing them is future work, not fabricated in this checkpoint.
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

No filesystem/network/child_process import (`commercial-order.ts` imports only four sibling domain modules, all type-only). No provider/model hard-coding. No secret/credential material. No execution of the resolved recipe/plan. No merge/deploy/release/production/publication/customer-binding/legal/financial action anywhere in this checkpoint's source.

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
- `node --test dist/tests/*.test.js`: **718/718 pass** (705 pre-existing on this base + 13 new), 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/`: exactly 3 new files (`src/domain/commercial-order.ts`, `src/fixtures/website-build-v1-commercial-order.ts`, `tests/commercial-order.test.ts`), 428 insertions, 0 deletions, 0 deletions/modifications to any existing file.
- `git diff origin/main -- package.json package-lock.json`: empty — zero new dependency introduced.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant.
