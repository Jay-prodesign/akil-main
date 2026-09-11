# SVC-ADM-001 — Trusted Service Catalog Admission (Rev98/Rev101 gap Family 1)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Handoff Rev101's "MANDATORY REMAINING FAMILIES" list names Family 1 verbatim: *"trusted canonical service/delivery knowledge boundary resolving commercial service identity to admitted service/version/intake/recipe/capabilities/work-plan inputs/acceptance/approvals/gap behavior."*
- This is the same gap Brain's Rev74 review of PR #32 (`AUD-V5-GAP-02`) already found and recorded: `resolveCanonicalServiceFromOrder` (renamed under Rev77 to `resolveDeclaredServiceFromOrder`) "accepts a caller-supplied catalog with no admission/provenance/authority binding — a caller can fabricate a serviceRef → blueprint/version/recipe mapping and obtain RESOLVED." Rev74's own bounded correction path was to honestly narrow the claim (no admitted/trusted catalog authority primitive existed anywhere in the repo at the time, and inventing one on that PR would have been the forbidden "second catalog/orchestration system"), leaving canonical-resolution provenance an explicitly recorded OPEN gap. Family 1 is that gap's closure, as its own dedicated checkpoint.
- Branch: `claude/svc-adm-001-trusted-service-catalog`, cut from `claude/v5-cold-start-commercial-order-resolution` (PR #32) at its exact head `8b95aa337da5e4fb5498f8ebf8f0b2ced8ae93bc` — a direct dependent of that branch's own `commercial-order.ts` contract, matching the same stacking precedent as `LOCAL-EXEC-002` on `LOCAL-EXEC-001` and `DEP-ORCH-001` on `RUNTIME-001`.
- No-duplication check: a repository-wide search (repeated fresh for this checkpoint) confirms no admitted/trusted catalog authority/provenance primitive exists anywhere else in `src/domain/` — the closest candidates, `OfferBlueprintVersion`/`DeliveryRecipe`, are validated-construction domain objects, not an admission system. `capability-admission.ts` and `partner-capability-admission.ts` are the two existing "admitted X" precedents this checkpoint composes the *pattern* of (single fail-closed construction gate; terminal one-way revoke with temporal-integrity checking) — neither is imported or modified, since neither models a service-catalog entry.

## Scope (this checkpoint)

`src/domain/service-catalog-admission.ts` — composing `commercial-order.ts`'s own unmodified `CommercialOrder`/`ServiceCatalogEntry`/`DeclaredServiceLookupResult` (type-only imports, never redefined) and `delivery-recipe.ts`'s `DeliveryRecipe`/`offer-blueprint.ts`'s `OfferBlueprintVersion` (type references only):

- **Admission gate**: `ServiceCatalogAdmission`/`admitServiceCatalogEntry` — the only construction path (no separate promotion step, mirroring `capability-admission.ts`). Fails closed unless `catalogEntry.recipeId` exactly matches the supplied `recipe.recipeId` (an admission can never bind a catalog entry to a recipe it does not actually declare), and requires non-empty `admittedByAuthorityId`, `evidenceRef`, and `admittedAt`.
- **Revocation**: `revokeServiceCatalogAdmission` — terminal, one-way (`ADMITTED` → `REVOKED` only), reusing `partner-capability-admission.ts`'s own Rev62 temporal-integrity discipline verbatim: `revokedAt` must not be strictly before `admittedAt` (equal accepted as immediate revocation).
- **Trusted resolution / gap behavior**: `TrustedServiceResolution`/`resolveTrustedServiceForOrder` — composes `resolveDeclaredServiceFromOrder`'s own output (never re-implemented) with the caller-supplied admitted catalog:
  - `UNRESOLVED_SERVICE` passes straight through unchanged when the declared lookup itself failed.
  - `RESOLVED` only when exactly one currently-`ADMITTED` admission matches the declared lookup's exact `blueprintId`/`blueprintVersion`/`recipeId` triple for that `serviceRef`.
  - `NOT_ADMITTED` — a first-class, honest disposition, never a thrown error and never conflated with `RESOLVED` — whenever a service is declared-resolvable but no matching admission exists, the only matching admission is `REVOKED`, or the only matching admission is bound to a different (stale/superseded) `blueprintVersion`.
  - Throws (never guesses a "closest" admission) on an ambiguous multi-admission match, matching `resolveDeclaredServiceFromOrder`'s own established convention.
- `tests/service-catalog-admission.test.ts` (16 tests: SA1-SA16) and `tests/svc-adm-001-boundary-scan.test.ts` (6 tests).

## Explicitly deferred (not fabricated)

- **No wiring into `commercial-order-intake.ts`'s `intakeSoldScopeFromResolution`.** That function still accepts a raw `DeclaredServiceLookupResult` directly; teaching it (or a caller) to require a `TrustedServiceResolution` first is a follow-up composition, not fabricated here, to keep this checkpoint the smallest honest closure of the named gap.
- **No real service catalog/product/SKU/pricing system.** `ServiceCatalogEntry` remains exactly what `commercial-order.ts` already defines it as — this checkpoint only adds the missing trust/provenance layer on top, never a second catalog model.
- **No "intake/capabilities/work-plan inputs" modeling beyond what already exists.** Family 1's description spans a wide surface; `admission-readiness.ts`, `project-plan.ts`, and `capability-admission.ts` already cover intake-readiness, work-plan, and capability admission respectively. This checkpoint closes specifically the still-open sub-gap Brain's own Rev74 review named: catalog-entry admission/provenance.
- **No expiry/review-by-date on a `ServiceCatalogAdmission`.** Unlike `PartnerCapabilityClaim`, a service catalog admission has no natural review cadence modeled yet; adding one without a real operational trigger would be invented scope.

## Architecture / semantic invariants (verified by test)

- Admission: binds serviceRef/blueprint/version/recipe and authority/evidence correctly (SA1); rejects a `catalogEntry.recipeId`/`recipe.recipeId` mismatch (SA2); rejects empty `admittedByAuthorityId` (SA3), `evidenceRef` (SA4), `admittedAt` (SA5).
- Revocation: transitions to `REVOKED` with a recorded reason (SA6); fails closed on double-revoke (SA7); rejects a `revokedAt` strictly before `admittedAt` (SA8); accepts `revokedAt === admittedAt` (SA9).
- Trusted resolution: passes through `UNRESOLVED_SERVICE` (SA10); resolves `RESOLVED` on an exact admitted match (SA11); the gap-behavior case — `NOT_ADMITTED` when declared-resolvable but unadmitted (SA12); never trusts a `REVOKED` admission (SA13); never trusts a stale-blueprint-version admission (SA14); throws on ambiguous multi-admission match (SA15); never substitutes a different serviceRef's admission (SA16).

## Hard Non-Scope

No modification to `commercial-order.ts`, `commercial-order-intake.ts`, `delivery-recipe.ts`, or `offer-blueprint.ts` (all read-only type dependencies here); no real network/database/vendor SDK call anywhere; no persistence/durable store for admissions (caller-supplied `ReadonlyArray<ServiceCatalogAdmission>`, same pattern as `resolveDeclaredServiceFromOrder`'s own caller-supplied catalog); no admin/UI wiring; no new runtime dependency.

## Evidence

- `npx tsc --noEmit -p .`: exit 0, strict mode (`exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`).
- `npm run test`: **755/755 pass** (733 pre-existing on the `AUD-V5-GAP-02`/PR #32 base + 22 new: 16 in `tests/service-catalog-admission.test.ts`, 6 in `tests/svc-adm-001-boundary-scan.test.ts`).
- `package.json`: zero new runtime dependency; the `clean` script (`"rm -rf dist"` wired into `build`) was reapplied on this branch (its older base predated that fix) after a stale cross-branch `dist/` directory caused 5 unrelated test failures on first run — resolved by `rm -rf dist` + the script fix, with no source change.
- Files touched: `src/domain/service-catalog-admission.ts` (new), `tests/service-catalog-admission.test.ts` (new), `tests/svc-adm-001-boundary-scan.test.ts` (new), `package.json` (clean-script fix), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending fresh Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — this branch's base is PR #32's own branch, not `main`; its own eventual PR is stacked on PR #32. Per Current Project State Rev90/95/97/98/99/100's continuous-execution batch-mode authorization, reaffirmed and extended by canonical Handoff Rev101's own "CONTINUOUS EXECUTION / NO PARKING" dispatch and BATCH END CONTRACT, independent Brain exact-head review of this checkpoint is deferred to the one consolidated end-of-batch packet alongside PR #32, #38, #39, RUNTIME-001, V5-PTN-002 (Handoff-Rev101-corrected), V4-EFF-001 (Handoff-Rev101-corrected), LOCAL-EXEC-001 (Handoff-Rev101-corrected), LOCAL-EXEC-002, OBS-TEL-001, and DEP-ORCH-001.
