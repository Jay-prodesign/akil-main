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
