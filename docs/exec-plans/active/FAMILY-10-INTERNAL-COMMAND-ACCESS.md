# Family 10 — Internal Operations/Command Frontend Convergence, wired to Family 2 (Rev98/Rev103)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Rev98 Family 10: "internal operations/command + customer progress/approval frontend convergence." Canonical Handoff Rev103's "NEXT GRAPH" text names it explicitly: *"Rev98 Family 10 internal operations/command + customer progress/approval frontend convergence as Family 2 becomes available."*
- `internal-command-projection.ts` (V5-CMD-001, V5 Workstream J §14) itself recorded, verbatim, the exact dependency this checkpoint closes: *"this repository has no internal/staff authentication concept anywhere... Live routing and internal authentication remain explicitly open dependencies... not fabricated here."* Family 2 now exists — this checkpoint is that wiring.
- Branch `claude/family-10-internal-command-access`, created by merging `claude/family-2-staff-ingress-boundary` (PR #53) with `claude/v5-cmd-001-internal-command-projection` (Rev90-corrected) — both trace to the same `main` ancestor (`3226c76fa338e425e553638e5f5f48924182a1c0`), clean merge on every source/test file; doc-only conflicts in `CURRENT_STATE.md`/`V2_TO_V5.md` resolved by keeping both independently-true narratives in sequence. 738/738 tests pass on the merged base before this checkpoint's own new code.

## Scope (this checkpoint)

`src/web/internal-command-access.ts` — the access-control layer §14 itself named as its own missing piece, nothing more:

- `requireInternalCommandAccess` — the one required gate: a valid staff session (Family 2's unmodified `requireStaffSession`) that resolves to exactly one current, tenant-scoped `OrganizationMembership` (Family 2's unmodified `requireCurrentStaffMembership`).
- `resolveInternalCommandCenterView` — gates access, then delegates entirely to `internal-command-projection.ts`'s unmodified `buildInternalCommandCenterProjection` for the actual read-model aggregation. Adds no new attention/partner data source, no independent judgment, no persistence.
- `tests/family-10-internal-command-access.test.ts` (7 tests: F10-1–F10-7) and `tests/family-10-boundary-scan.test.ts` (6 tests).

## Explicitly deferred (not fabricated)

- **No modification to `internal-command-projection.ts`, `staff-route-guard.ts`, `staff-membership-guard.ts`, `staff-session-context.ts`, or `staff-session-provider.ts`.** All five are read-only dependencies; every existing guard is reused exactly as-is.
- **No `AuthorityContext`/permission-policy wiring.** Exactly the same deferral Family 2 itself recorded — this checkpoint gates *identity*, not authorization policy for which internal actions a given role may take.
- **No HTTP route/transport wiring.** Like V2-APP-001's own `session-context.ts`/`route-guard.ts` precedent, this is the access-control composition function only; binding it to an actual `node:http` route is a separate, later concern.
- **No other six of §14's eight named internal surfaces** (Projects/Repositories/Engineering, Operations/Capabilities/Providers, Approvals/Protected Gates, Evidence/Audit/Incidents, Workers/Routing/Evaluations, Product Lab/Reusable Capabilities) — `internal-command-projection.ts` itself already scoped this to the two surfaces with real backing data; this checkpoint does not expand that scope, only unblocks it.
- **No customer-facing progress/approval surface** (§14's second half, "customer progress/approval frontend convergence") — a separate, larger, customer-facing scope than this internal-side checkpoint.

## Architecture / semantic invariants (verified by test)

- `requireInternalCommandAccess` returns the session+membership pair for a valid, bound session (F10-1); throws `StaffUnauthenticatedError` for an undefined token, never reaching the membership check (F10-2); throws `StaffUnauthenticatedError` against the production provider regardless of token — no real IdP admitted (F10-3); throws `NoStaffMembershipError` when authenticated but unbound — a valid session alone is never sufficient (F10-4).
- `resolveInternalCommandCenterView` delegates to the unmodified projection once access is granted, correctly echoing `generatedAt`/aggregating attention and partner data (F10-5); never reaches the projection when the session is unauthenticated (F10-6) or when the authenticated staff member has no membership in this tenant (F10-7) — fail-closed access strictly precedes data aggregation.
- Boundary scan confirms structurally: this module never imports the customer-facing `session-context.ts`/`session-provider.ts`/`route-guard.ts` (internal command access cannot be reached through a customer session, by construction); `resolveInternalCommandCenterView`'s own source text calls `requireInternalCommandAccess` strictly before `buildInternalCommandCenterProjection`.

## Hard Non-Scope

No modification to `internal-command-projection.ts`, `staff-session-context.ts`, `staff-session-provider.ts`, `staff-route-guard.ts`, `staff-membership-guard.ts`, `organization-membership.ts`, or `tenant-scope.ts` (all read-only dependencies); no real network/IdP call anywhere; no persistence; no HTTP route wiring; no new runtime dependency; no `AuthorityContext` composition.

## Evidence

- `npx tsc --noEmit -p .` / `npm run build`: exit 0, strict mode.
- `npm run test`: **754/754 pass** (738 pre-existing + 13 original + 3 new Rev106 tests: 2 functional + 1 boundary-scan).
- `package.json`: zero new runtime dependency.
- Files touched: `src/web/internal-command-access.ts` (new), `tests/family-10-internal-command-access.test.ts` (new), `tests/family-10-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Rev106 correction (F1 — authentication is not authorization / cross-tenant read)

- Brain's Rev106 periodic HIGH-RISK sweep (canonical Handoff, fresh-read 2026-09-12) reviewed PR #55's exact head `ae2b67dc5c7bfd11fd0152c8806e5e56265914a1` and returned `CHANGES_REQUIRED, HIGH-RISK`: `requireInternalCommandAccess` checked only a staff session + a matching tenant-scoped membership, then `resolveInternalCommandCenterView` delegated to `internal-command-projection.ts`'s own intentionally cross-tenant, company-wide aggregation. Because no `AuthorityContext`/permission/role policy was enforced, any authenticated member matching one tenant could be represented as authorized to read the cross-tenant internal command center — membership alone must never grant global internal visibility.
- Independently re-verified before fixing: `authority.ts`'s own `AuthorityContext` is itself hard tenant-scoped (`CrossTenantAuthorityError` rejects any cross-tenant operation), so it does not "honestly apply" as a cross-tenant authorization grant — reusing it here would contradict its own invariant, not satisfy Rev106's first remedy option. No other authority/permission primitive in this repository extends to "internal staff, entitled to see all-tenant data."
- Fixed on the same branch, per Rev106's own explicit fallback ("keep the access layer tenant-bounded and do not expose cross-tenant/company-wide data until the explicit authority-composition policy exists"): `resolveInternalCommandCenterView` now filters `attentionItems` to only the resolved membership's own `tenantId` (`OperationsAttentionItem` already carries a real `tenantId` field - no new lookup invented) before calling the unmodified `buildInternalCommandCenterProjection`, and always passes an empty `partnerClaims` array (`PartnerCapabilityClaim` carries no tenant field at all, so no honest tenant filter can be constructed for it, and an unscoped pass-through would repeat exactly the finding). `internal-command-projection.ts` itself is untouched — it still faithfully aggregates whatever it is given; the tenant boundary now lives entirely in this access layer.
- This branch also merged the corrected `claude/family-2-staff-ingress-boundary` head, so `requireCurrentStaffMembership`/`resolveCurrentStaffMembership` are picked up here renamed to `requireMatchingStaffMembership`/`resolveMatchingStaffMembership` (see that branch's own "Rev106 correction" section; mechanical rename only, no behavior change).
- New adversarial tests F10-8 (a second tenant's attention item is never included in the returned view) and F10-9 (partner claims never surface through this tenant-membership-only gate, even when supplied) prove the boundary; a new boundary-scan test confirms structurally that `resolveInternalCommandCenterView`'s own source never forwards `input.partnerClaims` directly and does filter by `access.membership.tenantId`.
- Sanity-checked: temporarily reverted the fix (passed `input.attentionItems`/`input.partnerClaims` straight through, unfiltered) and confirmed exactly the 3 tests proving this dimension (F10-8, F10-9, and the boundary-scan structural check) then failed; restored the fix and reconfirmed 754/754 pass.

## Status

**IMPLEMENTED / SELF-VALIDATED (Rev106-corrected)** — pending independent verification per canonical Handoff Rev105 (self-review alone does not qualify as delegated VERIFY). This checkpoint gates access to internal data via authentication/organizational-membership identity binding, which falls inside Rev105/Execution Contract §9's SAFE_MERGE exclusion list (auth/IAM/authority) — it is not eligible for `SAFE_MERGE` to `main` regardless of verification outcome, and Rev106 additionally confirms this surface is HIGH/PROTECTED. `MERGE_DISPOSITION: HOLD_MERGE` — this branch is a merge of the Family 2 branch and the V5-CMD-001 branch; its own eventual PR should be reviewed alongside both upstream source PRs as part of the one consolidated end-of-batch Brain review packet.
