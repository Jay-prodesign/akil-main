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
 *
 * F3 correction: this function's own array-equality idempotency proof
 * (T7/T8) is necessary but was found insufficient by Brain review - it
 * does not prove that *persisted* job creation happens once. See
 * `persistWiredOutcomeJobs` in `durable-outcome-job-store.ts`, which wraps
 * this function's output in an explicit idempotent durable write.
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
      // F4 correction: independently validate this JobAdmissionResult's
      // own lineage against the planAdmission it is claimed to belong to -
      // do not trust that whatever produced `jobAdmissions` (typically
      // `admitJobs`) did so correctly. The wiring boundary fails closed on
      // its own, so a hand-built or mixed-lineage JobAdmissionResult can
      // never reach `createOutcomeJob` (T5).
      if (
        jobAdmission.tenantId !== input.planAdmission.tenantId ||
        jobAdmission.projectId !== input.planAdmission.projectId ||
        jobAdmission.planId !== input.planAdmission.planId ||
        jobAdmission.planVersion !== input.planAdmission.planVersion
      ) {
        throw new InvalidOutcomeJobWiringError(
          `jobAdmission for spec "${jobAdmission.specId}" does not belong to the given planAdmission's tenant/project/plan/version`,
        );
      }
      const spec = specsBySpecId.get(jobAdmission.specId);
      if (spec === undefined) {
        throw new InvalidOutcomeJobWiringError(
          `no OutcomeJobSpec found for admitted specId "${jobAdmission.specId}"`,
        );
      }
      if (
        spec.tenantId !== jobAdmission.tenantId ||
        spec.projectId !== jobAdmission.projectId ||
        spec.planId !== jobAdmission.planId ||
        spec.planVersion !== jobAdmission.planVersion ||
        spec.requirementId !== jobAdmission.requirementId
      ) {
        throw new InvalidOutcomeJobWiringError(
          `matched OutcomeJobSpec "${spec.specId}" does not agree with jobAdmission's tenant/project/plan/version/requirement lineage`,
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
