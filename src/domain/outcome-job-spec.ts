import type { ProjectPlanVersion, PlanNode } from "./project-plan.js";
import type { RequirementId } from "./offer-blueprint.js";

export class InvalidOutcomeJobSpecError extends Error {
  constructor(reason: string) {
    super(`Invalid OutcomeJobSpec: ${reason}`);
    this.name = "InvalidOutcomeJobSpecError";
  }
}

type OutcomeJobSpecId = string & { readonly __brand: "OutcomeJobSpecId" };

/**
 * A derived, not-yet-executing job specification (DEL-003 "Compiler
 * output contracts" #7) - compatible with, but structurally distinct
 * from, the AKI-BE-001 `OutcomeJob` runtime record: an OutcomeJobSpec is
 * plan-compilation output; turning it into a live `OutcomeJob` (via
 * `createOutcomeJob`) is a separate, later step outside this bounded
 * slice. `jobFamily`/`intendedOutcome` map conceptually onto
 * `OutcomeJob.jobFamily`/`businessObjective` so a future integration does
 * not need new vocabulary.
 */
export interface OutcomeJobSpec {
  readonly tenantId: ProjectPlanVersion["tenantId"];
  readonly projectId: ProjectPlanVersion["projectId"];
  readonly planId: ProjectPlanVersion["planId"];
  readonly planVersion: ProjectPlanVersion["version"];
  readonly specId: OutcomeJobSpecId;
  readonly requirementId: RequirementId;
  readonly jobFamily: string;
  readonly intendedOutcome: string;
  readonly prerequisites: ReadonlyArray<RequirementId>;
  readonly sourceBlueprintId: ProjectPlanVersion["sourceBlueprintId"];
  readonly sourceBlueprintVersion: ProjectPlanVersion["sourceBlueprintVersion"];
}

/**
 * Rev62 AUD-DEL-02 correction: `ProjectPlanVersion` identity is
 * project-scoped (a `planId` is never asserted unique across an entire
 * tenant), but `specId` previously omitted `projectId` entirely. Two
 * distinct, equally legitimate projects in the same tenant can compile a
 * plan with the same `planId`/version/requirement (nothing forbids
 * reusing a planId across projects), which produced identical `specId`
 * values - and `wireAdmittedOutcomeJobs` reuses `specId` verbatim as the
 * runtime `jobId`, which `FileDurableOutcomeJobStore` keys by
 * tenantId + jobId. `projectId` is now part of `specId` so two projects
 * sharing a planId/version/requirement can never collide on runtime job
 * identity.
 */
function specIdFor(plan: ProjectPlanVersion, node: PlanNode): OutcomeJobSpecId {
  return `${plan.projectId}:${plan.planId}:v${plan.version}:${node.requirementId}` as OutcomeJobSpecId;
}

/**
 * T6/T9: derives exactly one OutcomeJobSpec per REQUIRED plan node,
 * preserving full plan/requirement/blueprint lineage on every spec.
 * NOT_APPLICABLE/UNKNOWN/BLOCKED nodes are out-of-scope candidates and are
 * excluded from the committed job set (T9) - the only way a requirement
 * becomes committed is an explicit REQUIRED disposition, which itself
 * only follows from blueprint necessity or an explicit sold-scope
 * inclusion (see `compilePlan`), never a silent default.
 */
export function deriveOutcomeJobSpecs(
  plan: ProjectPlanVersion,
): ReadonlyArray<OutcomeJobSpec> {
  return plan.nodes
    .filter((node) => node.disposition === "REQUIRED")
    .map((node) => ({
      tenantId: plan.tenantId,
      projectId: plan.projectId,
      planId: plan.planId,
      planVersion: plan.version,
      specId: specIdFor(plan, node),
      requirementId: node.requirementId,
      jobFamily: node.requirementId,
      intendedOutcome: node.description,
      prerequisites: node.dependsOn,
      sourceBlueprintId: plan.sourceBlueprintId,
      sourceBlueprintVersion: plan.sourceBlueprintVersion,
    }));
}
