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
  type RoutedExecutionAssignment,
} from "../domain/outcome-job-routing-execution.js";
import type { VerificationResult } from "../domain/verification-result.js";

/**
 * Application-boundary authorization for ordinary lifecycle transitions
 * (T2/T8): requires the authority's tenant to match the job's tenant,
 * then WRITE permission. An ordinary transition is a normal write, not
 * a protected action.
 */
export function authorizedTransitionOutcomeJob(
  authority: AuthorityContext,
  job: OutcomeJob,
  to: OutcomeJobState,
): OutcomeJob {
  requireSameTenant(authority, job.tenantId);
  requirePermission(authority, "WRITE");
  return transitionOutcomeJob(job, to);
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
 * `authorizedTransitionOutcomeJob` (this does not introduce a new
 * privilege tier for beginning execution - see
 * `outcome-job-routing-execution.ts`'s own doc comment for why the
 * ordinary path is deliberately left open rather than narrowed here),
 * plus a valid, exactly-matching `RoutedExecutionAssignment` delegated
 * entirely to the existing, unmodified
 * `authorizeOutcomeJobExecutionFromRouting`.
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
