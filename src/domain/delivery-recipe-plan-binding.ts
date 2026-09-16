import type { ProjectPlanVersion } from "./project-plan.js";
import type { ServiceCatalogAdmission } from "./service-catalog-admission.js";
import type { DeliveryRecipe } from "./delivery-recipe.js";
import type { OutcomeJobSpec } from "./outcome-job-spec.js";

export class InvalidDeliveryRecipePlanBindingError extends Error {
  constructor(reason: string) {
    super(`Invalid DeliveryRecipe/Plan binding: ${reason}`);
    this.name = "InvalidDeliveryRecipePlanBindingError";
  }
}

/**
 * AI-004A: closes the gap `service-catalog-admission.ts` and
 * `outcome-job-spec.ts` both leave open - a `DeliveryRecipe` trusted at
 * service admission (`ServiceCatalogAdmission.recipeId`) is never actually
 * preserved into the compiled `ProjectPlanVersion`/`OutcomeJobSpec`
 * lineage, so nothing downstream can honestly say which recipe a given
 * plan/job was built against. One `OutcomeJobSpec`-level provenance record
 * per bound job - identity only, no execution/resume/approval authority
 * (invariant 9; actually running a step remains entirely governed by
 * whatever separate execution/routing authority applies to `OutcomeJob`
 * transitions in outcome-job.ts, untouched by this module).
 */
export interface DeliveryRecipeJobBinding {
  readonly specId: OutcomeJobSpec["specId"];
  readonly requirementId: OutcomeJobSpec["requirementId"];
}

/**
 * The provenance record produced by `bindAdmittedRecipeToPlan`.
 *
 * `consumedRecipeVersion` is recorded honestly as the concrete recipe
 * version actually bound here - it does NOT claim that the
 * `ServiceCatalogAdmission` itself independently admitted this exact
 * recipe version (`ServiceCatalogAdmission` carries `recipeId` only, never
 * a version), so this field must never be read back as an admission-level
 * version proof.
 */
export interface DeliveryRecipePlanBinding {
  readonly tenantId: ProjectPlanVersion["tenantId"];
  readonly projectId: ProjectPlanVersion["projectId"];
  readonly planId: ProjectPlanVersion["planId"];
  readonly planVersion: ProjectPlanVersion["version"];
  readonly serviceRef: ServiceCatalogAdmission["serviceRef"];
  readonly blueprintId: ProjectPlanVersion["sourceBlueprintId"];
  readonly blueprintVersion: ProjectPlanVersion["sourceBlueprintVersion"];
  readonly boundRecipeId: DeliveryRecipe["recipeId"];
  readonly consumedRecipeVersion: DeliveryRecipe["version"];
  readonly admissionEvidenceRef: string;
  readonly boundJobs: ReadonlyArray<DeliveryRecipeJobBinding>;
}

/**
 * Fail-closed composition binding an exact ADMITTED `ServiceCatalogAdmission`
 * + concrete versioned `DeliveryRecipe` to a compiled `ProjectPlanVersion`
 * and the `OutcomeJobSpec`s derived from it. This module does not compile
 * plans, derive specs, admit catalog entries, or execute recipe steps - it
 * only composes those existing, already-validated outputs and records that
 * composition honestly. Every check below throws rather than silently
 * degrading or guessing:
 *
 *  - `admission` must currently be ADMITTED - a REVOKED (or any other
 *    non-ADMITTED) admission can never bind;
 *  - `admission.blueprintId`/`blueprintVersion` must exactly match
 *    `plan.sourceBlueprintId`/`sourceBlueprintVersion`;
 *  - `admission.recipeId` must exactly match `recipe.recipeId` - a
 *    caller-supplied recipe with the same shape but a different recipeId
 *    can never become authoritative just by being passed in;
 *  - `recipe.jobFamily` must be compatible with the plan's blueprint. This
 *    is independently re-checked here rather than trusted as an automatic
 *    consequence of the blueprint/version match above, matching the
 *    `wireAdmittedOutcomeJobs` precedent of never trusting an upstream
 *    caller's own internal consistency;
 *  - every entry in `specs` must belong to this exact
 *    tenant/project/plan/version/blueprint lineage - no cross-plan
 *    substitution.
 *
 * Purely a function of its inputs: calling this again with the exact same
 * `admission`/`recipe`/`plan`/`specs` always produces a deep-equal result,
 * so a caller replaying the same admitted inputs (e.g. after a restart)
 * can never produce a divergent binding.
 */
export function bindAdmittedRecipeToPlan(input: {
  admission: ServiceCatalogAdmission;
  recipe: DeliveryRecipe;
  plan: ProjectPlanVersion;
  specs: ReadonlyArray<OutcomeJobSpec>;
}): DeliveryRecipePlanBinding {
  const { admission, recipe, plan, specs } = input;

  if (admission.status !== "ADMITTED") {
    throw new InvalidDeliveryRecipePlanBindingError(
      `admission for serviceRef "${admission.serviceRef}" must have status "ADMITTED" (got "${admission.status}")`,
    );
  }

  if (
    admission.blueprintId !== plan.sourceBlueprintId ||
    admission.blueprintVersion !== plan.sourceBlueprintVersion
  ) {
    throw new InvalidDeliveryRecipePlanBindingError(
      `admission blueprint "${admission.blueprintId}" v${admission.blueprintVersion} does not match plan's sourceBlueprint "${plan.sourceBlueprintId}" v${plan.sourceBlueprintVersion}`,
    );
  }

  if (admission.recipeId !== recipe.recipeId) {
    throw new InvalidDeliveryRecipePlanBindingError(
      `admission.recipeId "${admission.recipeId}" does not match recipe.recipeId "${recipe.recipeId}" - a differently-identified recipe can never be bound in its place`,
    );
  }

  if (recipe.jobFamily !== plan.sourceBlueprintId) {
    throw new InvalidDeliveryRecipePlanBindingError(
      `recipe.jobFamily "${recipe.jobFamily}" is not compatible with plan's sourceBlueprintId "${plan.sourceBlueprintId}"`,
    );
  }

  for (const spec of specs) {
    if (
      spec.tenantId !== plan.tenantId ||
      spec.projectId !== plan.projectId ||
      spec.planId !== plan.planId ||
      spec.planVersion !== plan.version
    ) {
      throw new InvalidDeliveryRecipePlanBindingError(
        `spec "${spec.specId}" does not belong to the given plan's tenant/project/plan/version lineage`,
      );
    }
    if (
      spec.sourceBlueprintId !== plan.sourceBlueprintId ||
      spec.sourceBlueprintVersion !== plan.sourceBlueprintVersion
    ) {
      throw new InvalidDeliveryRecipePlanBindingError(
        `spec "${spec.specId}" sourceBlueprint does not match the given plan's sourceBlueprint`,
      );
    }
  }

  return {
    tenantId: plan.tenantId,
    projectId: plan.projectId,
    planId: plan.planId,
    planVersion: plan.version,
    serviceRef: admission.serviceRef,
    blueprintId: plan.sourceBlueprintId,
    blueprintVersion: plan.sourceBlueprintVersion,
    boundRecipeId: recipe.recipeId,
    consumedRecipeVersion: recipe.version,
    admissionEvidenceRef: admission.evidenceRef,
    boundJobs: specs.map((spec) => ({
      specId: spec.specId,
      requirementId: spec.requirementId,
    })),
  };
}
