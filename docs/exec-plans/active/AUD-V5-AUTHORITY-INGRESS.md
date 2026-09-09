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

**IMPLEMENTED / SELF-VALIDATED** — pending Brain independent exact-head review. Not yet `VERIFIED`/`PASS`/`CLOSED`; Claude's authority ends at this status per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE` — normal task-scoped PR against `main`; merge requires a separately granted protected owner-gate, never inferred from any prior PR's grant. Known pending reconciliation with PR #31 before both can land (see "Known future reconciliation" above).
