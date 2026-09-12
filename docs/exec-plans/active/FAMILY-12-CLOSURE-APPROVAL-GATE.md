# Family 12 — Website Build Cold-Start Convergence: Approval → Closure Glue (Rev98/Rev103)

## Provenance

- Governing authority: DEC-160 V2→V5 Autonomous Engineering Corridor. Rev98's Family 12: *"Website Build Cold-Start First Customer end-to-end convergence proving verified sale/order -> trusted service/recipe -> intake/readiness -> bootstrap -> dynamic work plan -> admitted routing -> authorized execution -> QA/evidence -> approval -> closure, reusing existing segments and adding only missing glue/tests."* Rev103's own NEXT GRAPH text names Family 12 as still open.
- Before selecting a slice, a fresh repo-wide audit (this session, 2026-09-12) mapped every named chain segment against live repo state to find the genuine, provable gaps — not a re-implementation of segments that already exist. Findings:
  - readiness → plan-admission → outcome-job-wiring: already composed and tested (`plan-admission.ts`'s `admitPlan` calls `evaluateReadiness` directly; `tests/outcome-job-wiring.test.ts` T1/T9 chain `admitPlan`→`admitJobs`→`wireAdmittedOutcomeJobs`).
  - evidence → verification → VERIFIED: already composed and tested (`outcome-job.ts`'s `verifyOutcomeJob` requires a matching `PASSED` `VerificationResult`).
  - **approval → closure: no glue at all.** `outcome-job.ts`'s own `MAIN_PATH_TRANSITIONS` lets any caller move a `VERIFIED` job straight to `CLOSED` via the generic `transitionOutcomeJob`, with nothing requiring an approval first. The existing SALE-TO-CLOSE E2E test (`tests/external-sale-bootstrap.test.ts`, R10) empirically demonstrates exactly this gap: it calls `transitionOutcomeJob(verifiedJob, "CLOSED")` with no approval object anywhere in scope, and it succeeds.
  - Two other real gaps were found (admitted routing ↔ authorized execution being disjoint islands; sale/order and trusted-service work living on unmerged branches) but are each their own separately-scoped follow-up, not attempted in this checkpoint.
- This checkpoint closes the one cleanly-scoped, low-blast-radius gap: approval → closure.

## Design rationale (why a new module rather than extending `outcome-job.ts` or reusing `approval-reference.ts`)

- `approval-reference.ts`'s `ApprovalReference` is bound to a `ProjectPlanVersion`'s id/version/content hash — a plan-approval concept. `OutcomeJob` carries no plan-linkage field to validate against, and adding one would be an unreviewed change to AKI-BE-001's own already Brain-**VERIFIED/COMPLETED** canonical shape — outside this checkpoint's delegated envelope (`CLAUDE.md`: material changes to already-verified canonical work are not Claude's to make unilaterally).
- Removing the generic `VERIFIED -> CLOSED` edge from `outcome-job.ts`'s own `MAIN_PATH_TRANSITIONS` (to force every caller through an approval gate) would break `tests/outcome-job.test.ts`'s own existing assertion that this transition is valid — a real behavior change to AKI-BE-001's verified contract, not a bounded addition. Not attempted for the same reason as above.
- Instead, `src/domain/outcome-job-closure-approval.ts` is a purely additive composition module, mirroring exactly how `verifyOutcomeJob` is already a stricter, dedicated gate layered *next to* (not replacing) the generic transition table for `VERIFYING -> VERIFIED`: a new `ClosureApprovalReference` type (mirroring `ApprovalReference`'s own tenant/scope-binding discipline, Rev62 AUD-V2-01, but bound to job identity instead of plan identity — no payload hash needed since `OutcomeJob` has no post-creation "update" function anywhere in this repository), and `closeOutcomeJobWithApproval`, an opt-in stricter path that requires a valid, matching approval before delegating to the existing, unmodified `transitionOutcomeJob`.

## Scope (this checkpoint)

- **`src/domain/outcome-job-closure-approval.ts`** (new): `ClosureApprovalReference` (`closureApprovalId`, `tenantId`, `customerId`, `projectId`, `jobId`, `approvedAt`, `approverRef`); `createClosureApprovalReference` (binds every scoping field directly from a caller-supplied `OutcomeJob`, never separate caller-typed identifiers); `isClosureApprovalValidForJob` (fail-closed on every scoping dimension — tenant/customer/project/job — mirroring `isApprovalValidForPlan`); `closeOutcomeJobWithApproval` (throws `OutcomeJobClosureNotApprovedError` unless a valid matching approval is supplied, then delegates the actual transition entirely to the existing `transitionOutcomeJob`).
- `tests/outcome-job-closure-approval.test.ts` (11 tests: A1–A11) and `tests/outcome-job-closure-approval-boundary-scan.test.ts` (5 tests).

## Explicitly deferred (not fabricated)

- **No modification to `outcome-job.ts`.** `MAIN_PATH_TRANSITIONS`, `transitionOutcomeJob`, `verifyOutcomeJob`, and every other export remain exactly as AKI-BE-001 left them (Brain-verified). The bare `transitionOutcomeJob(verifiedJob, "CLOSED")` path this checkpoint does not close remains available to any caller who does not opt into `closeOutcomeJobWithApproval` — narrowing that further would itself be the unreviewed behavior change this checkpoint deliberately avoids.
- **No modification to `approval-reference.ts`.** Read-only precedent; its own plan-approval concept is untouched.
- **No wiring into the SALE-TO-CLOSE E2E floor or any other call site.** This checkpoint adds the sanctioned composition function; adopting it at a specific orchestration call site (e.g. a future Family 12 convergence layer, or `external-sale-bootstrap.ts` on its own branch) is a separate, later integration step.
- **No resolution of the other two Family 12 gaps found in this session's audit** (admitted-routing ↔ authorized-execution being disjoint islands; sale/order and trusted-service work living on unmerged branches) — each is its own separately-scoped follow-up.
- **No new IAM/authority primitive.** `approverRef` is an opaque caller-supplied string, exactly like `ApprovalReference.approverRef` — this module does not resolve "who may approve" from anywhere; that composition (e.g. with `authority.ts`) remains a separate, later, explicit gap, matching this repository's own established discipline for every prior checkpoint that touches approval/authority.

## Architecture / semantic invariants (verified by test)

- `createClosureApprovalReference` fails closed on empty/whitespace-only `closureApprovalId`/`approvedAt`/`approverRef` (A2, A3); binds every scoping field from the supplied job, not caller-typed input (A1).
- `isClosureApprovalValidForJob` is true only for the exact job an approval was created for (A4); false for a different `jobId` even in the same tenant/customer/project (A5); false across a cross-tenant substitution even when the `jobId` string happens to collide (A6) — mirroring `ApprovalReference`'s own Rev62 AUD-V2-01 cross-tenant-collision discipline.
- `closeOutcomeJobWithApproval` closes a `VERIFIED` job given a matching approval (A7); throws `OutcomeJobClosureNotApprovedError` when no approval is supplied — a `VERIFIED` job is never closed "by default" (A8); throws when the supplied approval belongs to a different job (A9); throws when the job is not yet `VERIFIED` even with a well-formed matching approval, since it still delegates to `transitionOutcomeJob`'s own unmodified state-machine check (A10); an already-`CLOSED` job cannot be closed again, for the same reason (A11).
- Boundary-scan: never redefines `OutcomeJob`/`OutcomeJobState`; imports `transitionOutcomeJob` from the unmodified module; the approval check runs strictly before the transition call (an unapproved closure never reaches `transitionOutcomeJob` at all); `outcome-job.ts`'s own `MAIN_PATH_TRANSITIONS` still contains the untouched `VERIFIED -> CLOSED` edge; module exports exactly the expected surface.

## Hard Non-Scope

No modification to `outcome-job.ts`, `approval-reference.ts`, `verification-result.ts`, `evidence.ts`, or any other read-only precedent/type dependency; no wiring into any existing orchestration call site; no new IAM/authority primitive; no resolution of the other two Family 12 gaps found in this session's audit.

## Evidence

- `npx tsc --noEmit -p .` / `npm run build`: exit 0, strict mode.
- `npm run test`: **1013/1013 pass** (997 pre-existing + 16 new: 11 functional + 5 boundary-scan).
- Sanity-checked: temporarily removed the approval-validity check from `closeOutcomeJobWithApproval` (delegating straight to `transitionOutcomeJob` unconditionally) and confirmed exactly the 3 tests proving this dimension (A8, A9, and the boundary-scan ordering test) then failed — A10/A11 correctly still passed, since `transitionOutcomeJob`'s own unmodified state-machine check independently covers those cases, proving clean isolation between the two checks. Restored and reconfirmed 1013/1013 pass.
- `package.json`: zero new runtime dependency.
- Files touched: `src/domain/outcome-job-closure-approval.ts` (new), `tests/outcome-job-closure-approval.test.ts` (new), `tests/outcome-job-closure-approval-boundary-scan.test.ts` (new), this exec-plan, `docs/engineering/CURRENT_STATE.md`, `docs/exec-plans/corridors/V2_TO_V5.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending independent verification per canonical Handoff Rev105 (self-review alone does not qualify as delegated VERIFY). This checkpoint composes `OutcomeJob`/tenant/customer/project identity — the same shape of composition as `V3-OWN-001`/`approval-reference.ts` — and does not touch authentication/session/IAM directly, but per this session's established convention every checkpoint remains `SAFE_MERGE`-excluded pending explicit Brain classification rather than assumed safe. `MERGE_DISPOSITION: HOLD_MERGE` — cut fresh from `main`, PR #58 (open/draft), reviewed as part of the one consolidated end-of-batch Brain review packet.
