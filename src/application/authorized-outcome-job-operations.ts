import {
  requireSameTenant,
  requirePermission,
  requireProtectedActionAuthorization,
  type AuthorityContext,
} from "../domain/authority.js";
import {
  transitionOutcomeJob,
  verifyOutcomeJob,
  type OutcomeJob,
  type OutcomeJobState,
} from "../domain/outcome-job.js";
import {
  authorizeOutcomeJobExecutionFromRouting,
  isExecutionRoutingRequirementValidForJob,
  type RoutedExecutionAssignment,
  type ExecutionRoutingRequirement,
} from "../domain/outcome-job-routing-execution.js";
import {
  closeOutcomeJobWithApproval,
  type ClosureApprovalReference,
} from "../domain/outcome-job-closure-approval.js";
import type { VerificationResult } from "../domain/verification-result.js";

export class ClosureRequiresApprovalGateError extends Error {
  constructor() {
    super(
      "OutcomeJob cannot be closed via the ordinary transition path; use authorizedCloseOutcomeJobWithApproval",
    );
    this.name = "ClosureRequiresApprovalGateError";
  }
}

export class MissingExecutionRoutingRequirementError extends Error {
  constructor() {
    super(
      "authorizedTransitionOutcomeJob to EXECUTING requires an ExecutionRoutingRequirement that exactly matches this job's tenant/customer/project/jobId",
    );
    this.name = "MissingExecutionRoutingRequirementError";
  }
}

export class ExecutionRequiresRoutingGateError extends Error {
  constructor() {
    super(
      "OutcomeJob's ExecutionRoutingRequirement is ROUTING_REQUIRED; it cannot begin executing via the ordinary transition path - use authorizedTransitionOutcomeJobToExecutingViaRouting",
    );
    this.name = "ExecutionRequiresRoutingGateError";
  }
}

/**
 * Application-boundary authorization for ordinary lifecycle transitions
 * (T2/T8): requires the authority's tenant to match the job's tenant,
 * then WRITE permission. An ordinary transition is a normal write, not
 * a protected action.
 *
 * Rev111 (Family 12 closure-approval-gate correction): `CLOSED` is
 * explicitly excluded here and fails closed with
 * `ClosureRequiresApprovalGateError`, never delegating to the generic
 * `transitionOutcomeJob`. Without this, any WRITE-permitted caller could
 * reach `CLOSED` through this ordinary path with no approval at all,
 * bypassing `outcome-job-closure-approval.ts`'s entire gate - this
 * checkpoint's own audit found exactly that a real, demonstrated gap.
 * Closing a `VERIFIED` job now requires
 * `authorizedCloseOutcomeJobWithApproval` below, mirroring how
 * `authorizedVerifyOutcomeJob` is already a stricter, dedicated path
 * layered next to this generic one rather than reachable through it.
 *
 * Brain Rev114/115/116 (independent exact-head review of the routing
 * glue): `EXECUTING` had the exact same class of bypass - any
 * WRITE-permitted caller could reach `EXECUTING` through this ordinary
 * path with no routing decision at all, even for a job whose own
 * admitted policy requires routed execution. Unlike `CLOSED`, `EXECUTING`
 * is not universally gated here (genuine non-routed staff-initiated work
 * exists and must keep working - see `jobAtVerifying`-style test
 * helpers) - instead every `EXECUTING` transition now requires the
 * caller to supply an `ExecutionRoutingRequirement` that exactly matches
 * this job's own tenant/customer/project/jobId (fails closed with
 * `MissingExecutionRoutingRequirementError` if absent or mismatched -
 * this is the honesty half of the fix: a caller cannot silently omit a
 * classification to get the permissive branch), and if that requirement
 * declares `ROUTING_REQUIRED`, this ordinary path fails closed with
 * `ExecutionRequiresRoutingGateError` regardless of anything else -
 * `authorizedTransitionOutcomeJobToExecutingViaRouting` becomes the only
 * authorized path for that job. `MANUAL_EXECUTION_ALLOWED` preserves the
 * ordinary path exactly as before.
 */
export function authorizedTransitionOutcomeJob(
  authority: AuthorityContext,
  job: OutcomeJob,
  to: OutcomeJobState,
  executionRoutingRequirement?: ExecutionRoutingRequirement,
): OutcomeJob {
  if (to === "CLOSED") {
    throw new ClosureRequiresApprovalGateError();
  }
  if (to === "EXECUTING") {
    if (
      executionRoutingRequirement === undefined ||
      !isExecutionRoutingRequirementValidForJob(executionRoutingRequirement, job)
    ) {
      throw new MissingExecutionRoutingRequirementError();
    }
    if (executionRoutingRequirement.policy === "ROUTING_REQUIRED") {
      throw new ExecutionRequiresRoutingGateError();
    }
  }
  requireSameTenant(authority, job.tenantId);
  requirePermission(authority, "WRITE");
  return transitionOutcomeJob(job, to);
}

/**
 * The only authorized path to `CLOSED`: requires the same tenant match
 * and EXECUTE permission as verification, PLUS explicit protected-action
 * authorization (mirroring `authorizedVerifyOutcomeJob` exactly - closing
 * a verified job is at least as sensitive as verifying it), PLUS a valid
 * `ClosureApprovalReference` for this exact job (delegated entirely to
 * the existing, unmodified `closeOutcomeJobWithApproval`).
 *
 * Rev111 F2: `ClosureApprovalReference.approverRef` is a caller-supplied
 * reference/label only - this module does not independently verify that
 * a specific person "approved" anything, and no real customer-approval
 * admission primitive exists anywhere in this repository to compose
 * instead (inventing one would be a second, unreviewed IAM concept,
 * which this checkpoint's delegated envelope does not permit). What
 * *is* real and already Brain-verified is `AuthorityContext`'s own
 * protected-decision-authority gate - requiring it here means a bare
 * fabricated approval reference is never, by itself, sufficient to
 * close a job: the caller must also independently hold real
 * protected-action authority, the same standard already required to
 * verify the job in the first place. Real customer-approval-identity
 * admission remains explicitly open, not fabricated.
 */
export function authorizedCloseOutcomeJobWithApproval(
  authority: AuthorityContext,
  job: OutcomeJob,
  approval: ClosureApprovalReference | undefined,
): OutcomeJob {
  requireSameTenant(authority, job.tenantId);
  requirePermission(authority, "EXECUTE");
  requireProtectedActionAuthorization(authority, "closeOutcomeJobWithApproval");
  return closeOutcomeJobWithApproval({ job, approval });
}

/**
 * Application-boundary authorization for the VERIFIED gate (T2/T8/T9):
 * requires the authority's tenant to match the job's tenant, EXECUTE
 * permission, AND explicit protected-action authorization. Verifying a
 * job is classified as a protected action - holding EXECUTE alone is
 * not sufficient (T9).
 */
export function authorizedVerifyOutcomeJob(
  authority: AuthorityContext,
  job: OutcomeJob,
  verificationResult: VerificationResult | undefined,
): OutcomeJob {
  requireSameTenant(authority, job.tenantId);
  requirePermission(authority, "EXECUTE");
  requireProtectedActionAuthorization(authority, "verifyOutcomeJob");
  return verifyOutcomeJob(job, verificationResult);
}

/**
 * Rev98 Family 12 (admitted-routing -> authorized-execution glue): the
 * properly-glued path from a `ROUTED` `WorkerRoutingDecision` to a job's
 * own `EXECUTING` transition. Same tenant match and WRITE permission as
 * `authorizedTransitionOutcomeJob`, plus a valid, exactly-matching
 * `RoutedExecutionAssignment` delegated entirely to the existing,
 * unmodified `authorizeOutcomeJobExecutionFromRouting`. This is the only
 * authorized path for a job whose `ExecutionRoutingRequirement` is
 * `ROUTING_REQUIRED` (Brain Rev114/115/116 correction above) - a caller
 * arriving here with a valid, job-matching, `ROUTED` assignment does not
 * additionally need to construct an `ExecutionRoutingRequirement`; a real
 * routed assignment is itself strictly stronger proof.
 */
export function authorizedTransitionOutcomeJobToExecutingViaRouting(
  authority: AuthorityContext,
  job: OutcomeJob,
  assignment: RoutedExecutionAssignment | undefined,
): OutcomeJob {
  requireSameTenant(authority, job.tenantId);
  requirePermission(authority, "WRITE");
  return authorizeOutcomeJobExecutionFromRouting({ job, assignment });
}
