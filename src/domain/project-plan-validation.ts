import type { ProjectPlanVersion } from "./project-plan.js";
import type { OfferBlueprintVersion, RequirementId } from "./offer-blueprint.js";

export class InvalidPlanValidationInputError extends Error {
  constructor(reason: string) {
    super(`Invalid plan validation input: ${reason}`);
    this.name = "InvalidPlanValidationInputError";
  }
}

export type PlanValidationFindingCode =
  | "MISSING_REQUIRED_COVERAGE"
  | "UNKNOWN_MANDATORY_REQUIREMENT"
  | "BLOCKED_MANDATORY_REQUIREMENT";

export interface PlanValidationFinding {
  readonly code: PlanValidationFindingCode;
  readonly requirementId: RequirementId;
  readonly message: string;
}

/**
 * DEL-003 "Compiler output contracts" #8: deterministic completeness
 * validation with explicit blocking findings. Deliberately independent of
 * `compilePlan` - it re-derives, from the blueprint alone, which
 * requirementIds must be covered, and cross-checks the plan's nodes
 * against that, rather than trusting that whatever produced `plan` did so
 * correctly. `status` is COMPLETE only when every REQUIRED blueprint
 * requirement has a matching node with disposition REQUIRED, and no node
 * anywhere in the plan is UNKNOWN or BLOCKED (T2/T4).
 */
export interface PlanValidationResult {
  readonly planId: ProjectPlanVersion["planId"];
  readonly planVersion: ProjectPlanVersion["version"];
  readonly status: "COMPLETE" | "INCOMPLETE";
  readonly findings: ReadonlyArray<PlanValidationFinding>;
}

export function validatePlan(
  plan: ProjectPlanVersion,
  blueprint: OfferBlueprintVersion,
): PlanValidationResult {
  if (plan.sourceBlueprintId !== blueprint.blueprintId) {
    throw new InvalidPlanValidationInputError(
      "plan.sourceBlueprintId does not match the given blueprint",
    );
  }
  // Rev62 AUD-DEL-01: blueprintId alone does not pin an exact blueprint
  // artifact - a plan compiled from one version of a blueprint must not
  // validate against a same-id, different-version blueprint, since that
  // version's requirement necessity/dependency set can differ.
  if (plan.sourceBlueprintVersion !== blueprint.version) {
    throw new InvalidPlanValidationInputError(
      "plan.sourceBlueprintVersion does not match the given blueprint's version",
    );
  }

  const nodesByRequirement = new Map(
    plan.nodes.map((node) => [node.requirementId, node]),
  );
  const findings: PlanValidationFinding[] = [];

  for (const requirement of blueprint.requirements) {
    const node = nodesByRequirement.get(requirement.requirementId);
    if (requirement.necessity === "REQUIRED" && node !== undefined && node.disposition === "BLOCKED") {
      findings.push({
        code: "BLOCKED_MANDATORY_REQUIREMENT",
        requirementId: requirement.requirementId,
        message: `REQUIRED requirement "${requirement.requirementId}" is BLOCKED and must be resolved before the plan can be complete`,
      });
      continue;
    }
    if (requirement.necessity === "REQUIRED") {
      if (node === undefined || node.disposition !== "REQUIRED") {
        findings.push({
          code: "MISSING_REQUIRED_COVERAGE",
          requirementId: requirement.requirementId,
          message: `REQUIRED blueprint requirement "${requirement.requirementId}" has no corresponding REQUIRED plan node`,
        });
        continue;
      }
    }
    if (node === undefined) {
      continue;
    }
    if (node.disposition === "UNKNOWN") {
      findings.push({
        code: "UNKNOWN_MANDATORY_REQUIREMENT",
        requirementId: requirement.requirementId,
        message: `requirement "${requirement.requirementId}" has an UNKNOWN disposition and must be resolved before the plan can be complete`,
      });
    }
    if (node.disposition === "BLOCKED") {
      findings.push({
        code: "BLOCKED_MANDATORY_REQUIREMENT",
        requirementId: requirement.requirementId,
        message: `requirement "${requirement.requirementId}" is BLOCKED and must be resolved before the plan can be complete`,
      });
    }
  }

  return {
    planId: plan.planId,
    planVersion: plan.version,
    status: findings.length === 0 ? "COMPLETE" : "INCOMPLETE",
    findings,
  };
}
