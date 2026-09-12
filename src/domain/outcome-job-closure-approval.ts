import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import { transitionOutcomeJob, type OutcomeJob } from "./outcome-job.js";

export class InvalidClosureApprovalReferenceError extends Error {
  constructor(reason: string) {
    super(`Invalid ClosureApprovalReference: ${reason}`);
    this.name = "InvalidClosureApprovalReferenceError";
  }
}

export class OutcomeJobClosureNotApprovedError extends Error {
  constructor(jobId: OutcomeJob["jobId"]) {
    super(`OutcomeJob ${jobId} cannot be closed: no valid ClosureApprovalReference was supplied for it`);
    this.name = "OutcomeJobClosureNotApprovedError";
  }
}

type ClosureApprovalId = string & { readonly __brand: "ClosureApprovalId" };

/**
 * Rev98 Family 12's own named chain segment: "... admitted routing ->
 * authorized execution -> QA/evidence -> approval -> closure." A fresh
 * repo-wide audit of the sale-to-close chain (this session, 2026-09-12)
 * found every other adjacent segment pair already composed and tested
 * (readiness -> plan-admission, plan-admission -> outcome-job-wiring,
 * evidence -> verification -> VERIFIED), but approval -> closure had no
 * glue at all: `outcome-job.ts`'s own `MAIN_PATH_TRANSITIONS` lets any
 * caller move a `VERIFIED` job straight to `CLOSED` via the generic
 * `transitionOutcomeJob`, with nothing requiring an approval first -
 * the existing SALE-TO-CLOSE E2E test (`tests/external-sale-bootstrap.test.ts`
 * R10) empirically demonstrates exactly this: it calls
 * `transitionOutcomeJob(verifiedJob, "CLOSED")` with no approval object
 * anywhere in scope, and it succeeds.
 *
 * `approval-reference.ts`'s own `ApprovalReference` is not reused
 * directly: it is bound to a `ProjectPlanVersion`'s id/version/content
 * hash, a plan-approval concept, not a job-closure concept - `OutcomeJob`
 * carries no plan linkage field to validate against, and inventing one
 * would be a real, unreviewed change to AKI-BE-001's own already-
 * Brain-VERIFIED/COMPLETED canonical shape, which this checkpoint does
 * not attempt. `ClosureApprovalReference` is instead a new, narrowly-
 * scoped construct mirroring `ApprovalReference`'s own tenant/scope-
 * binding discipline (Rev62 AUD-V2-01: bind every scoping field
 * directly, never rely on jobId uniqueness alone) but bound to job
 * identity instead of plan identity - `OutcomeJob` has no post-creation
 * "update" function anywhere in this repository, so unlike a
 * `ProjectPlanVersion` there is no reconstruction-with-different-content
 * risk requiring a payload hash; tenant+customer+project+job identity is
 * the entire provable fact.
 *
 * `closeOutcomeJobWithApproval` is a purely additive composition
 * function: it does not modify `outcome-job.ts`'s own
 * `MAIN_PATH_TRANSITIONS` or `transitionOutcomeJob` at all (both remain
 * exactly as AKI-BE-001 left them, including the bare generic
 * VERIFIED -> CLOSED edge `tests/outcome-job.test.ts` already asserts) -
 * it is a stricter, opt-in path a caller can choose instead of the bare
 * transition, exactly mirroring how `verifyOutcomeJob` is a stricter,
 * dedicated gate layered next to (not replacing) the generic table for
 * VERIFYING -> VERIFIED. A future Family 12 orchestration layer can
 * require this function specifically; this checkpoint does not attempt
 * to retroactively close the bare-transition path, since doing so would
 * be a material behavior change to an already Brain-verified primitive,
 * outside this checkpoint's delegated envelope.
 */
export interface ClosureApprovalReference {
  readonly closureApprovalId: ClosureApprovalId;
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly approvedAt: string;
  readonly approverRef: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidClosureApprovalReferenceError(`${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new InvalidClosureApprovalReferenceError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidClosureApprovalReferenceError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * `job` supplies every scoping field directly (tenantId/customerId/
 * projectId/jobId) rather than accepting them as separate caller-typed
 * parameters, so a `ClosureApprovalReference` can never be constructed
 * for a job identity the caller did not actually have an `OutcomeJob`
 * value for.
 */
export function createClosureApprovalReference(input: {
  job: OutcomeJob;
  closureApprovalId: unknown;
  approvedAt: unknown;
  approverRef: unknown;
}): ClosureApprovalReference {
  const closureApprovalId = requireNonEmptyString(input.closureApprovalId, "closureApprovalId");
  const approvedAt = requireNonEmptyString(input.approvedAt, "approvedAt");
  const approverRef = requireNonEmptyString(input.approverRef, "approverRef");
  return {
    closureApprovalId: closureApprovalId as ClosureApprovalId,
    tenantId: input.job.tenantId,
    customerId: input.job.customerId,
    projectId: input.job.projectId,
    jobId: input.job.jobId,
    approvedAt,
    approverRef,
  };
}

/**
 * Fail-closed on every scoping dimension, mirroring
 * `isApprovalValidForPlan`'s own discipline: an approval granted for one
 * tenant/customer/project/job never silently validates a different one,
 * even if some individual fields happen to coincide.
 */
export function isClosureApprovalValidForJob(
  approval: ClosureApprovalReference,
  job: OutcomeJob,
): boolean {
  return (
    approval.tenantId === job.tenantId &&
    approval.customerId === job.customerId &&
    approval.projectId === job.projectId &&
    approval.jobId === job.jobId
  );
}

/**
 * The approval-gated closure path: throws
 * `OutcomeJobClosureNotApprovedError` rather than silently falling back
 * to the bare `transitionOutcomeJob(job, "CLOSED")` when no valid
 * approval is supplied - a `VERIFIED` job is never closed "by default."
 * Delegates the actual state transition entirely to the existing,
 * unmodified `transitionOutcomeJob`, so every one of its own invariants
 * (job must currently be `VERIFIED`, `CLOSED` has no further outbound
 * edges) still applies exactly as AKI-BE-001 specified - this function
 * adds a precondition, it does not re-implement or relax the state
 * machine.
 */
export function closeOutcomeJobWithApproval(input: {
  job: OutcomeJob;
  approval: ClosureApprovalReference | undefined;
}): OutcomeJob {
  if (input.approval === undefined || !isClosureApprovalValidForJob(input.approval, input.job)) {
    throw new OutcomeJobClosureNotApprovedError(input.job.jobId);
  }
  return transitionOutcomeJob(input.job, "CLOSED");
}
