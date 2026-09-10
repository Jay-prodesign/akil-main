# AUD-V5-AUTHORITY-INGRESS — Bind partner-capability admission/revocation to a real caller AuthorityContext

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor; Brain's Rev62 Handoff, V5 disposition: *"V5: CHANGES_REQUIRED — worker authority blocker + full-system authority ingress gap + Cold-Start First Customer convergence still open."* The Handoff's own "AUTHORIZED CORRECTION ORDER — NO FOUNDER RELAY" step 5: *"Converge full-system authority ingress/durability requirements at their correct architectural boundary; do not disguise local/reference implementations as production proof."* The "durability" half of step 5 was already closed by PR #30 (`AUD-DURABILITY-GAP`); this checkpoint closes a bounded, honest floor of the "authority ingress" half.
- **The exact finding** (Rev62, carried forward from Rev60), quoted in full: *"At final V5/system level the authority identity remains a caller-asserted string; there is no authenticated/authorized authority context proving that the supplied distinct string is actually an independent admitting authority. FINAL-V5 REQUIREMENT: bind admission to a trusted authority/ingress contract before claiming real non-self-certification at system level."*
- **Selection reasoning**: independently re-read this finding in full before selecting it (not accepted from a chat paraphrase). Confirmed against live source: `admitPartnerCapabilityClaim`/`revokePartnerCapabilityClaim` (`src/domain/partner-capability-admission.ts`) previously checked zero caller authority — *any* caller, holding no permission of any kind, could invoke either function successfully, as long as the `admittingAuthorityId` string happened to differ from the claim's own `partnerOrganizationId`. This repository already has a real, tested, application-boundary authority primitive for exactly this purpose (`src/domain/authority.ts`'s `AuthorityContext`, from `AKI-BE-001`) that was simply never wired into this module. Wiring it in is a small, honest, additive floor — not the full "trusted authority/ingress contract" Brain's FINAL-V5 REQUIREMENT ultimately asks for (see "Explicitly NOT closed" below), but a genuine, disclosed partial hardening using only existing, already-tested primitives.
- Branch: `claude/aud-v5-authority-ingress-binding`, cut fresh from merged `main`.
- `BASE_PROVENANCE_SHA`: `fe2cbc02f20e800b309e127288cc32a72176c109` (merged main, PR #25 — same base as PR #30/#31/#32).
- **Known future reconciliation**: this branch and PR #31 (`V5-PTN-001` Rev62 `revokedAt` hardening, still open/unreviewed) both modify `src/domain/partner-capability-admission.ts`. Per this corridor's standing rule ("never push a further commit onto a branch whose evidence has already been posted for review"), PR #31's branch was not touched — this is a deliberate fresh branch instead. The two will need reconciliation (rebase or merge-and-reconcile) before both can land; neither depends on the other's specific lines (PR #31 touches `revokePartnerCapabilityClaim`'s `revokedAt` validation only, this PR adds an `authority` parameter to both functions) so the merge is mechanical, not a design conflict.

## Goal

Close the specific, real fail-open gap the finding identifies: *any* caller — with no permission, no tenant match, no protected-action authorization — could currently admit or revoke a partner capability claim. Require the caller to hold a real, tenant-matched, protected-action-authorized `AuthorityContext` before either operation can proceed, using only the existing `authority.ts` primitives.

## Scope (this checkpoint)

- `src/domain/partner-capability-admission.ts`:
  - `PartnerCapabilityClaim` gains a `tenantId` field (`PartnerOrganization["tenantId"]`), populated in `createPartnerCapabilityClaim` from the given `partnerOrganization.tenantId` — the claim now carries its own tenant identity rather than only reaching it transitively through `partnerOrganizationId`.
  - `admitPartnerCapabilityClaim` and `revokePartnerCapabilityClaim` both gain a required `authority: AuthorityContext` parameter, checked fail-closed, in this order, before any existing business check: (1) `requireSameTenant(authority, claim.tenantId)` — structural, checked first, same discipline `authority.ts` already documents; (2) `requireProtectedActionAuthorization(authority, "<functionName>")` — admission/revocation are protected actions; (3) `requirePermission(authority, "WRITE")`.
  - Import of `requireSameTenant`, `requirePermission`, `requireProtectedActionAuthorization`, and the `AuthorityContext` type from the existing `./authority.js` sibling module — the only new import, disclosed and reflected in the updated boundary-scan test.

## Explicitly NOT closed (do not disguise this as the full FINAL-V5 requirement)

- This does **not** prove that `admittingAuthorityId` (the string persisted as `admittedByAuthorityId`) corresponds to any authenticated identity. `AuthorityContext` itself is explicitly documented as "a caller-supplied, application-boundary authority context - not identity/session resolution... this module does not resolve 'who is calling' from anywhere (that remains a future, explicit integration)." Binding the *specific asserted string* to a *proven* authenticated principal requires real session/identity infrastructure this repository does not have anywhere (same boundary that keeps V4 Workstreams C-H blocked) - inventing one here would be exactly the "disguise local/reference implementation as production proof" step 5 explicitly warns against.
- What this checkpoint proves instead, honestly: the *caller invoking the admission/revocation operation itself* must hold real, tenant-scoped, protected-action-authorized permission - closing the "any anonymous caller can admit/revoke" fail-open gap, which is a genuine (if partial) authority-ingress improvement.
- No new identity/session/authentication system, no credential material, no new provider/connector.

## Architecture / semantic invariants (verified by test)

- A freshly created claim carries `tenantId` derived from its `partnerOrganization`.
- Admission fails closed (`CrossTenantAuthorityError`) when the caller's `AuthorityContext` is bound to a different tenant than the claim.
- Admission fails closed (`InsufficientAuthorityError`) when the caller's `AuthorityContext` lacks `WRITE` permission.
- Admission fails closed (`ProtectedActionNotAuthorizedError`) when the caller's `AuthorityContext.canPerformProtectedActions` is `false`.
- The same three checks, in the same order, apply to revocation.
- The authority gate runs *before* the existing business-field checks (self-admission, evidence, timestamps) — a caller with mismatched tenant authority cannot even reach (or learn the outcome of) the `admittingAuthorityId` self-admission check.

## Hard Non-Scope

Exactly one new import (`authority.ts`, an existing sibling domain module — no filesystem/network/child_process coupling, verified by the updated boundary-scan test). No secret/credential material. No provider/model hard-coding. No merge/deploy/release/production/publication/customer-binding/legal/financial action anywhere in this checkpoint's source.

## Test Coverage

All in `tests/partner-capability-admission.test.ts` (existing H1-H19 updated to pass a valid `authority`; new adversarial tests H20-H27):

| Test | Acceptance direction |
|---|---|
| H20: a freshly created claim carries `tenantId` derived from its `partnerOrganization` | new field, positive path |
| H21: admission fails closed on cross-tenant authority | fail-closed, `CrossTenantAuthorityError` |
| H22: admission fails closed on missing `WRITE` permission | fail-closed, `InsufficientAuthorityError` |
| H23: admission fails closed on missing protected-action authorization | fail-closed, `ProtectedActionNotAuthorizedError` |
| H24: revocation fails closed on cross-tenant authority | fail-closed, `CrossTenantAuthorityError` |
| H25: revocation fails closed on missing `WRITE` permission | fail-closed, `InsufficientAuthorityError` |
| H26: revocation fails closed on missing protected-action authorization | fail-closed, `ProtectedActionNotAuthorizedError` |
| H27: the authority gate runs before business-field checks | ordering proof - a mismatched-tenant caller cannot reach the self-admission check |

Plus `tests/v5-ptn-001-boundary-scan.test.ts`'s import-list assertion updated to reflect the new, disclosed `authority.ts` import.

## Evidence

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, strict mode, zero errors, clean rebuild.
- `node --test dist/tests/*.test.js`: **713/713 pass** (705 pre-existing on this base + 8 new: H20-H27), 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/`: exactly 3 files touched (`src/domain/partner-capability-admission.ts`, `tests/partner-capability-admission.test.ts`, `tests/v5-ptn-001-boundary-scan.test.ts`), 267 insertions, 7 deletions — no new file.
- `git diff origin/main -- package.json package-lock.json`: empty — zero new dependency introduced.

## Status

**SUPERSEDED by the Rev74 correction below.** Original submission (exact head `7734820acd50a35af14df44baf851081bf8cc607`) was `IMPLEMENTED / SELF-VALIDATED`, pending Brain independent exact-head review.

## Rev74 correction (Brain CHANGES_REQUIRED, exact head `7734820acd50a35af14df44baf851081bf8cc607`)

Brain independently reviewed the exact head above and returned `CHANGES_REQUIRED` with two findings:

- **F1 CLAIM BOUNDARY** (verbatim): *"AuthorityContext tenant/protected-action/WRITE gating is useful partial hardening but does not establish authenticated caller identity; admittingAuthorityId remains caller-asserted and AuthorityContext itself does not prove who is calling. This head cannot claim final trusted-authority-ingress / real non-self-certification closure unless a real trusted authenticated ingress is wired."*
- **F2 ORDERING** (verbatim): *"claim.status/business checks occur before authority/tenant rejection, contrary to the stated authority-before-business fail-closed invariant and potentially disclose state to unauthorized/cross-tenant callers."*

**Reconciliation with PR #31**: per Brain's acceptance ("first reconcile PR #31 after its merge"), PR #31 (`b0b748e3f85ebb80d2d3f4d6b682e7647d480ac9`) was fresh-verified live and merged (squash) into `main` at `3226c76fa338e425e553638e5f5f48924182a1c0` under the Rev57 routine-technical-merge policy Brain itself invoked. This branch was then merged with the resulting `main` (merge commit, not rebase — avoids a force-push, which this corridor requires explicit human permission for on each occasion) to bring in PR #31's `revokedAt` temporal-integrity hardening alongside this branch's authority gating. The merge conflict in `partner-capability-admission.ts` was resolved by combining both: `revokePartnerCapabilityClaim` now carries both the authority gate and the `revokedAt`/`admittedAt` ordering check.

**F2 fix**: in both `admitPartnerCapabilityClaim` and `revokePartnerCapabilityClaim`, the three authority checks (`requireSameTenant`, `requireProtectedActionAuthorization`, `requirePermission`) now run *before* the claim-status business check, not after. An unauthorized or cross-tenant caller can no longer distinguish "wrong status" from "wrong authority" by which error is thrown — they always get the authority error first, regardless of the claim's actual state. Two new regression tests prove this directly: H28 (admission) and H29 (revocation) each construct a claim whose status is already invalid for the operation being attempted, pair it with a cross-tenant `AuthorityContext`, and assert `CrossTenantAuthorityError` (not the business-state error) is thrown.

**F1 fix**: doc comments on both functions were rewritten to explicitly label this hardening "PARTIAL HARDENING" and state that binding the specific `admittingAuthorityId` string to a proven authenticated principal remains an **explicit, unclosed external/integration dependency** (real session/identity infrastructure this repository does not have), not a claim of final V5 non-self-certification closure. No code-level claim overreach existed beyond the doc comments — the "Explicitly NOT closed" section above already carried the same honest disclosure; the correction makes that boundary explicit at the point of the F2 ordering fix as well, so a reader of either function's doc comment sees the same disclosure Brain's F1 finding asks for.

### New exact head

New head (this branch, `claude/aud-v5-authority-ingress-binding`, post-merge-with-`main` + F1/F2 fixes): see `git log -1` at time of push. Base is now `main` at `3226c76fa338e425e553638e5f5f48924182a1c0` (post-PR#31-merge), reachable via the merge commit's second parent.

## Evidence (Rev74 correction)

- `rm -rf dist && npx tsc -p tsconfig.json`: exit 0, strict mode, zero errors, clean rebuild.
- `node --test dist/tests/*.test.js`: **718/718 pass** (708 pre-existing on the new `main` base [705 + PR #31's 3 `revokedAt` tests] + 8 pre-existing H20-H27 + 2 new: H28, H29), 0 fail/cancelled/skipped/todo.
- `git diff --stat origin/main -- src/ tests/` (against the new `main`, post-PR#31-merge): 3 files touched (`src/domain/partner-capability-admission.ts`, `tests/partner-capability-admission.test.ts`, `tests/v5-ptn-001-boundary-scan.test.ts`), 357 insertions, 18 deletions — no new file.
- `git diff origin/main -- package.json package-lock.json`: empty — zero new dependency introduced.

## Status

**Rev77 update**: Brain independently reviewed this exact head (`619b02e0925ba126617394156ce4225a24e5a34e`) and returned, verbatim: *"PASS for the bounded PARTIAL HARDENING claim. Tenant/protected-action/WRITE checks execute before business-state checks; H28/H29 directly cover ordering; source and task record explicitly preserve authenticated identity binding as an OPEN external/integration dependency. This PASS does NOT establish final trusted-authenticated ingress and does NOT itself authorize merge."* No code correction required — F1/F2 from the Rev74 correction are confirmed satisfied for the bounded, honestly-scoped claim this PR actually makes.

`VERIFIED: PASS (bounded PARTIAL HARDENING claim only)` — this is Brain's independent verdict; Claude's own authority still ends at `IMPLEMENTED/SELF-VALIDATED` per `AGENTS.md` §10, and this record does not itself grant merge authority. `MERGE_DISPOSITION: HOLD_MERGE` — Brain's own review explicitly states the PASS does not authorize merge; a separate, explicitly granted protected owner-gate is still required, never inferred from this review or from any other PR's grant. PR #31 reconciliation is complete (merged first, then merged into this branch) — no further reconciliation pending. No further engineering action is pending on this PR unless a future Brain/Founder decision changes its disposition.
