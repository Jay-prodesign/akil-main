import type { OutcomeJob } from "./outcome-job.js";
import type { EvidenceReference } from "./evidence.js";

export class InvalidVerificationResultError extends Error {
  constructor(reason: string) {
    super(`Invalid VerificationResult: ${reason}`);
    this.name = "InvalidVerificationResultError";
  }
}

type VerificationId = string & { readonly __brand: "VerificationId" };

export type VerificationStatus = "PASSED" | "FAILED";

/**
 * Execution/tool success is not verification (DEC-122 RG-04). This record
 * is the sole authority for whether a job's evidence satisfied its
 * verification requirement - kept structurally distinct from
 * EvidenceReference (supports the claim) and AuditEvent (records
 * lineage).
 *
 * CXP-001D correction: `OutcomeJob` identity is canonically
 * tenantId+customerId+projectId+jobId, but this type previously carried
 * only tenantId+jobId, and `createVerificationResult` cross-checked only
 * those two dimensions against the given evidence/job. `jobId` is a
 * derived, human-readable string, not a globally unique identifier
 * (see `evidence.ts`), so a same-tenant, same-jobId `VerificationResult`
 * genuinely produced for a different customer/project's job could
 * otherwise satisfy this one. `customerId`/`projectId` are now preserved
 * and cross-checked the same way `tenantId`/`jobId` already are.
 */
export interface VerificationResult {
  readonly verificationId: VerificationId;
  readonly tenantId: OutcomeJob["tenantId"];
  readonly customerId: OutcomeJob["customerId"];
  readonly projectId: OutcomeJob["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly evidenceId: EvidenceReference["evidenceId"];
  readonly verificationRequirementRef: string;
  readonly status: VerificationStatus;
  readonly limitationOrFailureReason?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidVerificationResultError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidVerificationResultError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidVerificationResultError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidVerificationResultError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

export function createVerificationResult(input: {
  verificationId: unknown;
  job: OutcomeJob;
  evidence: EvidenceReference;
  verificationRequirementRef: unknown;
  status: unknown;
  limitationOrFailureReason?: unknown;
}): VerificationResult {
  if (input.evidence.jobId !== input.job.jobId) {
    throw new InvalidVerificationResultError(
      "evidence does not correspond to the given OutcomeJob",
    );
  }
  if (input.evidence.tenantId !== input.job.tenantId) {
    throw new InvalidVerificationResultError(
      "evidence does not belong to the given OutcomeJob's tenant",
    );
  }
  if (input.evidence.customerId !== input.job.customerId) {
    throw new InvalidVerificationResultError(
      "evidence does not belong to the given OutcomeJob's customer",
    );
  }
  if (input.evidence.projectId !== input.job.projectId) {
    throw new InvalidVerificationResultError(
      "evidence does not belong to the given OutcomeJob's project",
    );
  }
  const verificationId = requireNonEmptyString(input.verificationId, "verificationId");
  const verificationRequirementRef = requireNonEmptyString(
    input.verificationRequirementRef,
    "verificationRequirementRef",
  );
  if (input.status !== "PASSED" && input.status !== "FAILED") {
    throw new InvalidVerificationResultError(
      'status must be "PASSED" or "FAILED"',
    );
  }
  let limitationOrFailureReason: string | undefined;
  if (input.limitationOrFailureReason !== undefined) {
    limitationOrFailureReason = requireNonEmptyString(
      input.limitationOrFailureReason,
      "limitationOrFailureReason",
    );
  }
  return {
    verificationId: verificationId as VerificationId,
    tenantId: input.job.tenantId,
    customerId: input.job.customerId,
    projectId: input.job.projectId,
    jobId: input.job.jobId,
    evidenceId: input.evidence.evidenceId,
    verificationRequirementRef,
    status: input.status,
    ...(limitationOrFailureReason !== undefined ? { limitationOrFailureReason } : {}),
  };
}
