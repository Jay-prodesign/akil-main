# LOCAL-EXEC-004 — Staff/Team/Pool Wiring reusing Family 2 + V3 Membership/Authority (Phase L3)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Rev99/§21's Implementation Program names `LOCAL-EXEC-004` (Phase L3) as explicitly depending on Rev98 Family 2's "still-open trusted internal/staff ingress boundary" — `local-execution.ts`'s own doc comments record its `ownerMembershipRef`/`requestingOwnerMembershipRef` fields as "deliberately opaque caller-supplied strings, never resolved against any real authentication system, exactly matching this floor's own stated dependency boundary." Canonical Handoff Rev103's "NEXT GRAPH" text explicitly names `LOCAL-EXEC-004 staff/team/pool wiring reusing Family 2 + existing V3 membership/authority` as next-in-line now that Family 2 exists.
- Branch `claude/local-exec-004-staff-binding`, created by merging `claude/family-2-staff-ingress-boundary` (PR #53, `staff-session-context.ts`/`staff-membership-guard.ts`) with `claude/local-exec-003-codex-adapter` (PR #49, the full LOCAL-EXEC-001→003 chain) — both trace to the same `main` ancestor (`3226c76fa338e425e553638e5f5f48924182a1c0`), so the merge was clean on every source/test file; conflicts existed only in `CURRENT_STATE.md`/`V2_TO_V5.md` (both additive independent narratives, resolved by keeping both in sequence, no content dropped). 857/857 tests pass on the merged base before this checkpoint's own new code.

## Scope (this checkpoint)

`src/web/local-execution-staff-binding.ts` — a thin composition layer, three functions, each following the identical shape: resolve the caller's authenticated `StaffSessionContext` to a real, current, tenant-scoped `OrganizationMembership` via `staff-membership-guard.ts`'s unmodified `requireCurrentStaffMembership` (fails closed, never guesses), then call the corresponding unmodified `local-execution.ts` function with that membership's own `membershipId` as the trusted `ownerMembershipRef`/`requestingOwnerMembershipRef` — never a value the caller supplied directly for that field:

- `registerDeviceForAuthenticatedStaff` — wraps `registerDevice`.
- `createLocalWorkerRegistrationForAuthenticatedStaff` — wraps `createLocalWorkerRegistration`. `local-execution.ts`'s own Rev101 F1 guard (a worker's `ownerMembershipRef` must match its device's own) still applies underneath and is neither weakened nor duplicated here.
- `resolveEligibleLocalWorkersForAuthenticatedStaff` — wraps `resolveEligibleLocalWorkers`, so `PERSONAL_LOCAL`'s employee-isolation dimension is now driven by a real authenticated identity rather than a bare caller-asserted string.
- `tests/local-exec-004-staff-binding.test.ts` (10 tests: L4-1–L4-10) and `tests/local-exec-004-boundary-scan.test.ts` (5 tests).

## Explicitly deferred (not fabricated)

- **No modification to `local-execution.ts`, `staff-membership-guard.ts`, `staff-session-context.ts`, or `organization-membership.ts`.** All four are read-only dependencies; every existing guard (Rev101 F1's owner-match check, Family 2's ambiguity/no-membership fail-closed checks) is reused exactly as-is, not re-implemented.
- **No device bridge/control-channel wiring.** `LOCAL-EXEC-002`'s protocol layer is untouched; this checkpoint only changes how an `ownerMembershipRef` is obtained before a device/worker/eligibility call is made, not the protocol itself.
- **No `AuthorityContext`/permission-policy wiring.** Exactly the same deferral Family 2 itself recorded — this checkpoint binds *identity*, not authorization policy.
- **No TaskPacket/cross-worker handoff (LOCAL-EXEC-005's own scope).**
- **No admin/staff UI surface.**

## Architecture / semantic invariants (verified by test)

- `registerDeviceForAuthenticatedStaff` binds `ownerMembershipRef` to the resolved membership's `membershipId`, never a caller string (L4-1); throws `NoStaffMembershipError` — never registers a device — when the session has no membership in the tenant (L4-2); never accepts a same-`principalRef` membership from a different tenant (L4-3); throws `AmbiguousStaffMembershipError` rather than guessing on more than one match (L4-4).
- `createLocalWorkerRegistrationForAuthenticatedStaff` binds the worker's `ownerMembershipRef` to the resolved membership, matching its device's own owner (L4-5); fails closed before ever reaching the underlying constructor when the session is unbound (L4-6); a *different*, still-authenticated staff member's own resolved membership still fails `local-execution.ts`'s own Rev101 F1 ownership-mismatch guard when it doesn't match the device's enrolled owner — proving this binding layer does not create a bypass of that existing guard (L4-7).
- `resolveEligibleLocalWorkersForAuthenticatedStaff` derives `requestingOwnerMembershipRef` from the authenticated session, admitting only that staff member's own `PRIVATE` worker (L4-8); never admits another staff member's `PRIVATE` worker even in the same tenant — employee isolation now driven by real identity (L4-9); throws `NoStaffMembershipError` rather than silently resolving zero eligible workers when the requester itself is unbound (L4-10).
- Boundary scan confirms structurally: no raw `ownerMembershipRef: unknown`/`requestingOwnerMembershipRef: unknown` parameter exists anywhere in this module's own function signatures (every one is derived, never caller-supplied for that field), and `requireCurrentStaffMembership` is called exactly once per exported function (three total).

## Hard Non-Scope

No modification to `local-execution.ts`, `staff-session-context.ts`, `staff-membership-guard.ts`, `organization-membership.ts`, or `tenant-scope.ts` (all read-only dependencies); no real network/IdP call anywhere; no persistence; no admin/UI wiring; no new runtime dependency; no `AuthorityContext` composition.

## Evidence

- `npx tsc --noEmit -p .` / `npm run build`: exit 0, strict mode.
- `npm run test`: **874/874 pass** (857 pre-existing on the merged Family-2 + LOCAL-EXEC-003 base + 17 new: 11 functional + 6 boundary-scan, including the Rev106 correction's L4-11 and the new boundary-scan literal check).
- `package.json`: zero new runtime dependency.
- Files touched: `src/web/local-execution-staff-binding.ts` (new), `tests/local-exec-004-staff-binding.test.ts` (new), `tests/local-exec-004-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Rev106 correction (F1 — privilege escalation)

- Brain's Rev106 periodic HIGH-RISK sweep (canonical Handoff, fresh-read 2026-09-12) reviewed PR #54's exact head `9cb37dc7ab68f1030741aaad6d33c977d1416832` and returned `CHANGES_REQUIRED, HIGH-RISK`: `createLocalWorkerRegistrationForAuthenticatedStaff` proved only that the caller had a matching staff membership, then forwarded caller-controlled `trustStatus`/`authorityLevel` unchecked into `createLocalWorkerRegistration`, whose enum validation alone would accept `"ADMITTED"`/`"ELEVATED"`. Independently re-verified against source: confirmed exactly this pass-through existed with no intervening check — a merely authenticated organization member could mint an `ADMITTED`/`ELEVATED` local worker through this wrapper, conflicting with the Local Execution invariant that user-facing roles never silently equal action/protected authority.
- Rev106 also carried a `DEPENDENCY_CONSEQUENCE`: this checkpoint depends semantically on PR #53 (Family 2), whose own Rev106 F1 (membership-currentness overclaim) was corrected first — see `docs/exec-plans/active/FAMILY-2-STAFF-INGRESS-BOUNDARY.md`'s "Rev106 correction" section. This branch merged that corrected `claude/family-2-staff-ingress-boundary` head, so `requireCurrentStaffMembership`/`resolveCurrentStaffMembership` are picked up here renamed to `requireMatchingStaffMembership`/`resolveMatchingStaffMembership` (mechanical rename only, no behavior change).
- Fixed on the same branch: a fresh repo-wide search for an existing, semantically compatible admission/authority-grant primitive this wrapper could require instead (mirroring `service-catalog-admission.ts`'s own `authorizingWorker: AdmittedWorker` gate) found none reusable without inventing a new cross-domain `OrganizationRole`→authority mapping, which Rev106 explicitly forbids. Per Rev106's own second remedy option, `trustStatus`/`authorityLevel` are no longer caller-supplied parameters on `createLocalWorkerRegistrationForAuthenticatedStaff` at all — the function now always passes `"UNTRUSTED"`/`"STANDARD"` to the underlying constructor, mirroring `registerDevice`'s own "never born admitted" discipline. A real admission/elevation step remains a separate, later, explicitly-authorized grant mechanism; none is fabricated here.
- New adversarial test L4-11 proves an authenticated ordinary staff member can never self-elevate worker trust/authority — the registration always comes back `UNTRUSTED`/`STANDARD` regardless of caller intent. `tests/local-exec-004-boundary-scan.test.ts` gained a structural check that no `trustStatus: unknown`/`authorityLevel: unknown` parameter exists anywhere in this module and that the literal `"UNTRUSTED"`/`"STANDARD"` values are present in source.
- Sanity-checked: temporarily restored the vulnerable pass-through (`trustStatus: "ADMITTED"`, `authorityLevel: "ELEVATED"` hardcoded in place of the fix) and confirmed exactly the 2 tests proving this dimension (L4-11 + the boundary-scan literal check) then failed; restored the fix and reconfirmed 874/874 pass.

## Rev110 correction (stacked-ancestry gap — stale Family 2 wording propagated forward)

- Brain's Rev110 periodic HIGH-RISK sweep found that PR #56 (LOCAL-EXEC-005, stacked on this branch) still contained Family 2's superseded pre-Rev107 wording in `staff-membership-guard.ts` ("trusted for internal/staff action"), even though PR #53's own branch had since been corrected (Rev107, exact head `e2620f2181a36deafc38d196579bd22764a7b763`). Independently verified against source: this branch's own merge-base with `claude/family-2-staff-ingress-boundary` was `9efac4b` (Rev106-corrected only) — `e2620f2` was never merged forward, so the correction never reached this stack at all.
- Fixed by merging the current `claude/family-2-staff-ingress-boundary` head (`e2620f2`) into this branch directly — a clean, conflict-free merge (only the doc-comment wording changed on the Family 2 side; no source/test collision). No behavior change; 874/874 tests pass unchanged (same count as before the merge, confirming this was purely a wording-propagation gap, not a missing test).
- `DOWNSTREAM_CONSEQUENCE`: PR #56 (LOCAL-EXEC-005) and PR #57 (LOCAL-EXEC-006) must each merge this corrected head forward in turn, exactly mirroring how PR #56 originally merged this branch's Rev106 fix.

## Status

**IMPLEMENTED / SELF-VALIDATED (Rev106-corrected)** — pending independent verification per canonical Handoff Rev105 (delegated VERIFY requires a reviewer distinct from this implementing context; self-review alone does not qualify). This checkpoint composes/touches authentication and worker-authority identity binding (`OrganizationMembership`, `AdmittedWorker`-adjacent worker registration), which falls inside Rev105/Execution Contract §9's SAFE_MERGE exclusion list (auth/IAM/authority) — it is not eligible for `SAFE_MERGE` to `main` regardless of verification outcome, and Rev106 additionally confirms this surface is HIGH/PROTECTED. `MERGE_DISPOSITION: HOLD_MERGE` — this branch is a merge of the Family 2 branch and the LOCAL-EXEC-001→003 chain; its own eventual PR should be reviewed alongside all upstream source PRs (#49, #53) as part of the one consolidated end-of-batch Brain review packet.
