import type { ProjectPlanVersion } from "./project-plan.js";
import type { ServiceCatalogAdmission } from "./service-catalog-admission.js";
import type { DeliveryRecipe } from "./delivery-recipe.js";
import { deriveOutcomeJobSpecs, type OutcomeJobSpec } from "./outcome-job-spec.js";

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
  readonly customerId: ProjectPlanVersion["customerId"];
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
 *  - `specs` must be exactly the canonical `deriveOutcomeJobSpecs(plan)`
 *    output for this plan - no more, no fewer, no altered fields. A
 *    caller-supplied same-lineage spec with a fake/altered specId,
 *    requirementId, jobFamily, intendedOutcome or prerequisites, a
 *    duplicate, or an omitted canonically-required spec, can never be
 *    silently trusted as plan/job recipe provenance; `deriveOutcomeJobSpecs`
 *    is authoritative and deterministic from the plan's REQUIRED nodes, so
 *    the binding re-derives it and compares rather than trusting the
 *    caller's own copy.
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

  // V5-CONV-001 Rev117: the admission's own recorded recipeVersion is the
  // only authority for which concrete version of an admitted recipeId is
  // trusted - a different concrete version of the same recipeId can never
  // silently bind just because the recipeId matches.
  if (admission.recipeVersion !== recipe.version) {
    throw new InvalidDeliveryRecipePlanBindingError(
      `admission.recipeVersion "${admission.recipeVersion}" does not match recipe.version "${recipe.version}" for recipeId "${recipe.recipeId}" - a different concrete recipe version requires its own admission`,
    );
  }

  if (recipe.jobFamily !== plan.sourceBlueprintId) {
    throw new InvalidDeliveryRecipePlanBindingError(
      `recipe.jobFamily "${recipe.jobFamily}" is not compatible with plan's sourceBlueprintId "${plan.sourceBlueprintId}"`,
    );
  }

  const canonicalSpecs = deriveOutcomeJobSpecs(plan);
  if (specs.length !== canonicalSpecs.length) {
    throw new InvalidDeliveryRecipePlanBindingError(
      `specs (${specs.length}) do not match the canonical derived spec set for this plan (${canonicalSpecs.length}) - every canonically REQUIRED job spec must be present exactly once, with no extras or omissions`,
    );
  }
  const canonicalBySpecId = new Map(canonicalSpecs.map((s) => [s.specId, s]));
  const seenSpecIds = new Set<OutcomeJobSpec["specId"]>();
  for (const spec of specs) {
    if (seenSpecIds.has(spec.specId)) {
      throw new InvalidDeliveryRecipePlanBindingError(
        `duplicate spec "${spec.specId}" supplied - the canonical derived spec set never contains duplicates`,
      );
    }
    seenSpecIds.add(spec.specId);

    const canonical = canonicalBySpecId.get(spec.specId);
    if (canonical === undefined) {
      throw new InvalidDeliveryRecipePlanBindingError(
        `spec "${spec.specId}" is not part of the canonical derived spec set for this plan - a forged or foreign spec cannot be bound`,
      );
    }
    const prerequisitesMatch =
      spec.prerequisites.length === canonical.prerequisites.length &&
      spec.prerequisites.every((dep, i) => dep === canonical.prerequisites[i]);
    if (
      spec.tenantId !== canonical.tenantId ||
      spec.customerId !== canonical.customerId ||
      spec.projectId !== canonical.projectId ||
      spec.planId !== canonical.planId ||
      spec.planVersion !== canonical.planVersion ||
      spec.requirementId !== canonical.requirementId ||
      spec.jobFamily !== canonical.jobFamily ||
      spec.intendedOutcome !== canonical.intendedOutcome ||
      spec.sourceBlueprintId !== canonical.sourceBlueprintId ||
      spec.sourceBlueprintVersion !== canonical.sourceBlueprintVersion ||
      !prerequisitesMatch
    ) {
      throw new InvalidDeliveryRecipePlanBindingError(
        `spec "${spec.specId}" does not match the canonical derived spec for this plan - an altered/forged same-lineage spec cannot be bound`,
      );
    }
  }

  return {
    tenantId: plan.tenantId,
    customerId: plan.customerId,
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
