import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";

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
 * Two things are intentionally NOT modeled as allowed transitions yet,
 * each deferred to the checkpoint that builds its real precondition
 * rather than guessed here:
 *
 * - VERIFYING -> VERIFIED requires passing verification evidence (T5/T6:
 *   "VERIFIED cannot be reached merely because an executor/tool reports
 *   success"). EvidenceReference/VerificationResult don't exist yet
 *   (implementation-order step 5), so this edge is absent from the
 *   table below rather than allowed unconditionally.
 * - Exception-state entry/exit (BLOCKED/RECOVERING/ESCALATED/STOPPED):
 *   the canonical source names these states but does not specify their
 *   exact entry/exit graph, and T7 requires them to "preserve auditable
 *   transition reason/evidence references" - which needs AuditEvent
 *   (step 7). Inventing a specific graph now would be fabricating an
 *   unsourced business rule, so these states are declared in the type
 *   but have no transitions into or out of them in this checkpoint.
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
