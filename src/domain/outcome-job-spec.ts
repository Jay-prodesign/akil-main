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
  readonly customerId: ProjectPlanVersion["customerId"];
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
 *
 * CXP-001K correction: `projectId` itself is not asserted unique across
 * customers within a tenant either (see `project.ts`), so two distinct
 * customers' equally legitimate projects reusing the same `projectId`
 * string could still produce an identical `specId`/derived `jobId` under
 * the previous formula. `customerId` is now also part of `specId` for the
 * same reason `projectId` was added: two customers sharing a
 * projectId/planId/version/requirement can never collide on runtime job
 * identity either.
 *
 * Brain Rev44 F1 correction: raw `:`-delimited concatenation of
 * `customerId`/`projectId`/`planId`/`requirementId` is not actually
 * collision-safe - these components are validated only as non-empty
 * trimmed strings, never as delimiter-free, so a component itself
 * containing `:` can shift the apparent tuple boundaries (e.g.
 * `customerId="a:b", projectId="c"` and `customerId="a", projectId="b:c"`
 * would concatenate to the same string). `specId` is derived here via
 * `JSON.stringify` of the identity tuple as an array, which is injective
 * for this purpose: JSON string encoding escapes any `"`/`\` a component
 * contains, so the structural array/string delimiters (unescaped `"`,
 * `,`, `[`, `]`) can never be produced by component content and two
 * distinct tuples can never serialize to the same string.
 */
function specIdFor(plan: ProjectPlanVersion, node: PlanNode): OutcomeJobSpecId {
  return JSON.stringify([
    plan.customerId,
    plan.projectId,
    plan.planId,
    plan.version,
    node.requirementId,
  ]) as OutcomeJobSpecId;
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
      customerId: plan.customerId,
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
