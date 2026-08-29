import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJob, OutcomeJobState } from "./outcome-job.js";

export class InvalidDeliveryStatusError extends Error {
  constructor(reason: string) {
    super(`Invalid DeliveryStatusView: ${reason}`);
    this.name = "InvalidDeliveryStatusError";
  }
}

/**
 * V2 Client & Delivery OS - first bounded slice ("project/service status",
 * AKILTA + AI Commerce Master Release Plan v1.0 Section 5, "AKILTA v2.0 -
 * CLIENT & DELIVERY OS"). This is a pure read-model projection over the
 * already-canonical AKI-BE-001 `OutcomeJobState` lifecycle; it does not
 * introduce a new state machine or invent unsourced business rules about
 * what "in progress" or "blocked" mean beyond what that lifecycle already
 * distinguishes (main path vs. the four exception states).
 */
export type DeliveryStatusLabel =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "COMPLETE";

const EXCEPTION_STATES: ReadonlySet<OutcomeJobState> = new Set<OutcomeJobState>([
  "BLOCKED",
  "RECOVERING",
  "ESCALATED",
  "STOPPED",
]);

export interface DeliveryJobStatus {
  readonly jobId: OutcomeJob["jobId"];
  readonly jobFamily: string;
  readonly state: OutcomeJobState;
  readonly isBlocking: boolean;
}

export interface DeliveryStatusView {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly overallStatus: DeliveryStatusLabel;
  readonly jobs: ReadonlyArray<DeliveryJobStatus>;
}

/**
 * Aggregates a project's own `OutcomeJob` records into one customer-safe
 * status label plus a per-job breakdown. Every input job must belong to
 * the given project (same tenantId and projectId) - matching the
 * "cross-tenant/wrong-project ... binding fails closed" discipline already
 * established by DEL-003 T7; a caller passing a foreign job is treated as
 * contamination, not silently dropped or silently accepted.
 *
 * Status derivation (a direct read of the existing lifecycle, not a new
 * business rule): no jobs -> NOT_STARTED; any job in one of the four
 * canonical exception states -> BLOCKED; every job CLOSED -> COMPLETE;
 * otherwise -> IN_PROGRESS.
 */
export function computeDeliveryStatus(input: {
  project: Project;
  jobs: ReadonlyArray<OutcomeJob>;
}): DeliveryStatusView {
  for (const job of input.jobs) {
    if (job.tenantId !== input.project.tenantId) {
      throw new InvalidDeliveryStatusError(
        `job ${job.jobId} belongs to a different tenant than the given project`,
      );
    }
    if (job.projectId !== input.project.projectId) {
      throw new InvalidDeliveryStatusError(
        `job ${job.jobId} belongs to a different project than the given project`,
      );
    }
  }

  const jobs: DeliveryJobStatus[] = input.jobs.map((job) => ({
    jobId: job.jobId,
    jobFamily: job.jobFamily,
    state: job.state,
    isBlocking: EXCEPTION_STATES.has(job.state),
  }));

  let overallStatus: DeliveryStatusLabel;
  if (jobs.length === 0) {
    overallStatus = "NOT_STARTED";
  } else if (jobs.some((job) => job.isBlocking)) {
    overallStatus = "BLOCKED";
  } else if (jobs.every((job) => job.state === "CLOSED")) {
    overallStatus = "COMPLETE";
  } else {
    overallStatus = "IN_PROGRESS";
  }

  return {
    tenantId: input.project.tenantId,
    customerId: input.project.customerId,
    projectId: input.project.projectId,
    overallStatus,
    jobs,
  };
}
