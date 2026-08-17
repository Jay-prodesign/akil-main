import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { VerificationResult } from "./verification-result.js";

export class InvalidOutcomeJobError extends Error {
  constructor(reason: string) {
    super(`Invalid OutcomeJob: ${reason}`);
    this.name = "InvalidOutcomeJobError";
  }
}

export class InvalidOutcomeJobTransitionError extends Error {
  constructor(from: OutcomeJobState, to: OutcomeJobState) {
    super(`Invalid OutcomeJob transition: ${from} -> ${to}`);
    this.name = "InvalidOutcomeJobTransitionError";
  }
}

type JobId = string & { readonly __brand: "JobId" };

/**
 * Canonical OutcomeJob lifecycle (AKI-BE-001 execution record, "Scope
 * (Minimum Domain Objects)" #4): main path plus exception states.
 */
export type OutcomeJobState =
  | "DRAFT"
  | "QUALIFIED"
  | "READY"
  | "EXECUTING"
  | "VERIFYING"
  | "VERIFIED"
  | "CLOSED"
  | "BLOCKED"
  | "RECOVERING"
  | "ESCALATED"
  | "STOPPED";

/**
 * Belongs to exactly one tenantId + customerId + projectId. Always
 * constructed at DRAFT (the canonical main-path entry state).
 */
export interface OutcomeJob {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: JobId;
  readonly jobFamily: string;
  readonly businessObjective: string;
  readonly state: OutcomeJobState;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidOutcomeJobError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidOutcomeJobError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidOutcomeJobError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidOutcomeJobError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

export function createOutcomeJob(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  jobId: unknown;
  jobFamily: unknown;
  businessObjective: unknown;
}): OutcomeJob {
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidOutcomeJobError(
      "customer does not belong to the given tenantScope",
    );
  }
  if (input.project.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidOutcomeJobError(
      "project does not belong to the given tenantScope",
    );
  }
  if (input.project.customerId !== input.customer.customerId) {
    throw new InvalidOutcomeJobError(
      "project does not belong to the given customer",
    );
  }
  const jobId = requireNonEmptyString(input.jobId, "jobId");
  const jobFamily = requireNonEmptyString(input.jobFamily, "jobFamily");
  const businessObjective = requireNonEmptyString(
    input.businessObjective,
    "businessObjective",
  );
  return {
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: input.project.projectId,
    jobId: jobId as JobId,
    jobFamily,
    businessObjective,
    state: "DRAFT",
  };
}

/**
 * Deterministic, validated lifecycle transitions (T3/T4/RG-03).
 *
 * VERIFYING -> VERIFIED is deliberately absent from this generic
 * transition table, permanently, not just until step 5. It is
 * implemented separately below as `verifyOutcomeJob`, which requires a
 * passing `VerificationResult` (T5/T6). This keeps the generic
 * `transitionOutcomeJob` function structurally unable to fake VERIFIED
 * via a bare state assignment - execution/tool success is not
 * verification (DEC-122 RG-04), and that separation is enforced by the
 * type/function boundary itself, not left to caller discipline.
 *
 * Exception-state entry/exit (BLOCKED/RECOVERING/ESCALATED/STOPPED)
 * remains unimplemented: the canonical source names these states but
 * does not specify their exact entry/exit graph, and T7 requires them
 * to "preserve auditable transition reason/evidence references" - which
 * needs AuditEvent (step 7, not yet built). Inventing a specific graph
 * now would be fabricating an unsourced business rule, so these states
 * are declared in the type but have no transitions into or out of them
 * in this checkpoint either.
 */
const MAIN_PATH_TRANSITIONS: ReadonlyMap<
  OutcomeJobState,
  ReadonlySet<OutcomeJobState>
> = new Map([
  ["DRAFT", new Set<OutcomeJobState>(["QUALIFIED"])],
  ["QUALIFIED", new Set<OutcomeJobState>(["READY"])],
  ["READY", new Set<OutcomeJobState>(["EXECUTING"])],
  ["EXECUTING", new Set<OutcomeJobState>(["VERIFYING"])],
  ["VERIFYING", new Set<OutcomeJobState>()],
  ["VERIFIED", new Set<OutcomeJobState>(["CLOSED"])],
  ["CLOSED", new Set<OutcomeJobState>()],
  ["BLOCKED", new Set<OutcomeJobState>()],
  ["RECOVERING", new Set<OutcomeJobState>()],
  ["ESCALATED", new Set<OutcomeJobState>()],
  ["STOPPED", new Set<OutcomeJobState>()],
]);

export function transitionOutcomeJob(
  job: OutcomeJob,
  to: OutcomeJobState,
): OutcomeJob {
  const allowed = MAIN_PATH_TRANSITIONS.get(job.state);
  if (!allowed || !allowed.has(to)) {
    throw new InvalidOutcomeJobTransitionError(job.state, to);
  }
  return { ...job, state: to };
}

export class MissingVerificationEvidenceError extends Error {
  constructor(jobId: OutcomeJob["jobId"]) {
    super(
      `OutcomeJob ${jobId} cannot become VERIFIED without a VerificationResult`,
    );
    this.name = "MissingVerificationEvidenceError";
  }
}

export class VerificationNotPassedError extends Error {
  constructor(jobId: OutcomeJob["jobId"], status: string) {
    super(
      `OutcomeJob ${jobId} cannot become VERIFIED: verification status is ${status}, not PASSED`,
    );
    this.name = "VerificationNotPassedError";
  }
}

/**
 * T5/T6: the only way to move an OutcomeJob from VERIFYING to VERIFIED.
 *
 * T5: fails when required verification evidence is absent - either no
 * VerificationResult was supplied, or it exists but its status is not
 * PASSED (a FAILED/limited result is present evidence of non-verification,
 * not proof of verification).
 * T6: succeeds only when a VerificationResult for this exact job has
 * status PASSED.
 */
export function verifyOutcomeJob(
  job: OutcomeJob,
  verificationResult: VerificationResult | undefined,
): OutcomeJob {
  if (job.state !== "VERIFYING") {
    throw new InvalidOutcomeJobTransitionError(job.state, "VERIFIED");
  }
  if (verificationResult === undefined) {
    throw new MissingVerificationEvidenceError(job.jobId);
  }
  if (verificationResult.jobId !== job.jobId) {
    throw new InvalidOutcomeJobError(
      "verificationResult does not correspond to this OutcomeJob",
    );
  }
  if (verificationResult.status !== "PASSED") {
    throw new VerificationNotPassedError(job.jobId, verificationResult.status);
  }
  return { ...job, state: "VERIFIED" };
}
