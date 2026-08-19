import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { OutcomeJobSpec } from "./outcome-job-spec.js";
import { createOutcomeJob, type OutcomeJob } from "./outcome-job.js";
import type { PlanAdmissionResult, JobAdmissionResult } from "./plan-admission.js";

export class InvalidOutcomeJobWiringError extends Error {
  constructor(reason: string) {
    super(`Invalid OutcomeJob wiring input: ${reason}`);
    this.name = "InvalidOutcomeJobWiringError";
  }
}

/**
 * DEL-003 second bounded slice #4: projects ADMITTED OutcomeJobSpecs into
 * the existing AKI-BE-001 `OutcomeJob` runtime representation, preserving
 * exact tenant/project/plan/job lineage. `jobId` is deterministically
 * derived from `spec.specId` (itself `${planId}:v${version}:${requirementId}`,
 * see `outcome-job-spec.ts`) rather than freshly generated - this is what
 * makes wiring idempotent (T7/T8): calling this function again for the
 * exact same admitted specs always produces deep-equal `OutcomeJob`
 * objects (same jobId, same fields), so a caller collecting jobs into a
 * jobId-keyed store naturally cannot duplicate job creation on replay or
 * restart. T9: a non-ADMITTED plan wires zero jobs, unconditionally -
 * this is checked directly against `planAdmission.status`, not inferred
 * from the per-job results, so a caller cannot accidentally wire jobs for
 * a BLOCKED/WAITING plan even if `jobAdmissions` were (incorrectly)
 * constructed some other way.
 */
export function wireAdmittedOutcomeJobs(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  planAdmission: PlanAdmissionResult;
  jobAdmissions: ReadonlyArray<JobAdmissionResult>;
  specs: ReadonlyArray<OutcomeJobSpec>;
}): ReadonlyArray<OutcomeJob> {
  if (
    input.planAdmission.tenantId !== input.tenantScope.tenantId ||
    input.planAdmission.projectId !== input.project.projectId
  ) {
    throw new InvalidOutcomeJobWiringError(
      "planAdmission does not belong to the given tenantScope/project",
    );
  }

  if (input.planAdmission.status !== "ADMITTED") {
    return [];
  }

  const specsBySpecId = new Map(input.specs.map((spec) => [spec.specId, spec]));

  return input.jobAdmissions
    .filter((jobAdmission) => jobAdmission.status === "ADMITTED")
    .map((jobAdmission) => {
      const spec = specsBySpecId.get(jobAdmission.specId);
      if (spec === undefined) {
        throw new InvalidOutcomeJobWiringError(
          `no OutcomeJobSpec found for admitted specId "${jobAdmission.specId}"`,
        );
      }
      return createOutcomeJob({
        tenantScope: input.tenantScope,
        customer: input.customer,
        project: input.project,
        jobId: spec.specId,
        jobFamily: spec.jobFamily,
        businessObjective: spec.intendedOutcome,
      });
    });
}
