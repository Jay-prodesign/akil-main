export class InvalidDeliveryRecipeError extends Error {
  constructor(reason: string) {
    super(`Invalid DeliveryRecipe: ${reason}`);
    this.name = "InvalidDeliveryRecipeError";
  }
}

type RecipeId = string & { readonly __brand: "RecipeId" };
export type StepId = string & { readonly __brand: "StepId" };
export type GateId = string & { readonly __brand: "GateId" };
export type EvidenceRequirementId = string & {
  readonly __brand: "EvidenceRequirementId";
};

export type DeliveryGateType =
  | "CUSTOMER_INPUT"
  | "CUSTOMER_APPROVAL"
  | "HUMAN_REVIEW";

/**
 * V2-CDO-002 invariant: a gate is a requirement/reference only. It grants
 * no implicit execution or resume authority, and is structurally distinct
 * from `OutcomeJob`'s VERIFYING -> VERIFIED path (`verifyOutcomeJob` in
 * `outcome-job.ts`, unchanged and not referenced by this module) - D9.
 */
export interface DeliveryGate {
  readonly gateId: GateId;
  readonly type: DeliveryGateType;
}

/**
 * Stable evidence-class/reference metadata only - deliberately no raw
 * payload field, so this type cannot structurally carry secret material
 * (D10).
 */
export interface DeliveryEvidenceRequirement {
  readonly requirementId: EvidenceRequirementId;
  readonly evidenceClass: string;
  readonly description: string;
}

export type RecoverySemantics =
  | "NO_EXTERNAL_EFFECT"
  | "IDEMPOTENT_RETRY"
  | "COMPENSATABLE"
  | "IRREVERSIBLE_MANUAL_RECONCILIATION"
  | "UNKNOWN_BLOCKED";

const RECOVERY_VALUES: ReadonlySet<string> = new Set<string>([
  "NO_EXTERNAL_EFFECT",
  "IDEMPOTENT_RETRY",
  "COMPENSATABLE",
  "IRREVERSIBLE_MANUAL_RECONCILIATION",
  "UNKNOWN_BLOCKED",
]);

/**
 * D6: the only recovery classification this module treats as safe to
 * retry automatically. UNKNOWN_BLOCKED (and every other classification)
 * is fail-closed - not retryable - by omission from this one case, not by
 * a separate blocklist that could drift out of sync with the enum.
 */
export function isRetryableRecovery(recovery: RecoverySemantics): boolean {
  return recovery === "IDEMPOTENT_RETRY";
}

/**
 * D8: whether `action` is prohibited for `step` depends solely on
 * `step.prohibitedActions`. `allowedWorkerRefs` is never consulted here -
 * a worker/tool ref listed as "allowed" cannot remove an action from the
 * prohibited set, because this function structurally has no code path
 * that looks at `allowedWorkerRefs` at all.
 */
export function isProhibitedAction(
  step: DeliveryRecipeStep,
  action: string,
): boolean {
  return step.prohibitedActions.includes(action);
}

/**
 * `allowedWorkerRefs` and `requiredGateRefs`/`requiredEvidenceRefs` are
 * plain string/id references only - no provider/model implementation,
 * invocation config, or vendor-specific payload field exists on this
 * type, so a step cannot carry vendor lock-in by construction.
 */
export interface DeliveryRecipeStep {
  readonly stepId: StepId;
  readonly dependsOn: ReadonlyArray<StepId>;
  readonly allowedWorkerRefs: ReadonlyArray<string>;
  readonly prohibitedActions: ReadonlyArray<string>;
  readonly requiredGateRefs: ReadonlyArray<GateId>;
  readonly requiredEvidenceRefs: ReadonlyArray<EvidenceRequirementId>;
  readonly recovery: RecoverySemantics;
}

/**
 * A pure, versioned, machine-consumable definition of what an authorized
 * delivery recipe *is* (V2-CDO-002 GOAL). This module defines the recipe
 * only - it does not execute steps, dispatch workers, resolve gates, or
 * transition any `OutcomeJob` (D9; see `outcome-job.ts`, not imported
 * here). `jobFamily` maps onto the existing canonical
 * `OfferBlueprintVersion.blueprintId` identifier already used by the
 * `website-build-v1` DEL-003 blueprint/fixture (see
 * `src/fixtures/website-build-v1.ts`) - the pre-existing job-family
 * identifier this repository already has, reused rather than duplicated,
 * per the V2-CDO-002 task head's explicit instruction. Not tenant-scoped:
 * like `OfferBlueprintVersion`, a recipe is a shared, reusable template,
 * not tenant data.
 */
export interface DeliveryRecipe {
  readonly recipeId: RecipeId;
  readonly version: number;
  readonly jobFamily: string;
  readonly requiredCapabilityRefs: ReadonlyArray<string>;
  readonly requiredContextRefs: ReadonlyArray<string>;
  readonly policyRefs: ReadonlyArray<string>;
  readonly gates: ReadonlyArray<DeliveryGate>;
  readonly evidenceRequirements: ReadonlyArray<DeliveryEvidenceRequirement>;
  readonly steps: ReadonlyArray<DeliveryRecipeStep>;
  readonly completionRequirements: ReadonlyArray<EvidenceRequirementId>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidDeliveryRecipeError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidDeliveryRecipeError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidDeliveryRecipeError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidDeliveryRecipeError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidDeliveryRecipeError(`${field} must be an array`);
  }
  return value.map((item, index) => requireNonEmptyString(item, `${field}[${index}]`));
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new InvalidDeliveryRecipeError(`${field} must be a positive integer`);
  }
  return value;
}

function requireGateInput(
  input: unknown,
  index: number,
): { gateId: string; type: DeliveryGateType } {
  if (typeof input !== "object" || input === null) {
    throw new InvalidDeliveryRecipeError(`gates[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;
  const gateId = requireNonEmptyString(record["gateId"], `gates[${index}].gateId`);
  const type = record["type"];
  if (type !== "CUSTOMER_INPUT" && type !== "CUSTOMER_APPROVAL" && type !== "HUMAN_REVIEW") {
    throw new InvalidDeliveryRecipeError(
      `gates[${index}].type must be "CUSTOMER_INPUT", "CUSTOMER_APPROVAL", or "HUMAN_REVIEW"`,
    );
  }
  return { gateId, type };
}

function requireEvidenceRequirementInput(
  input: unknown,
  index: number,
): { requirementId: string; evidenceClass: string; description: string } {
  if (typeof input !== "object" || input === null) {
    throw new InvalidDeliveryRecipeError(`evidenceRequirements[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;
  return {
    requirementId: requireNonEmptyString(
      record["requirementId"],
      `evidenceRequirements[${index}].requirementId`,
    ),
    evidenceClass: requireNonEmptyString(
      record["evidenceClass"],
      `evidenceRequirements[${index}].evidenceClass`,
    ),
    description: requireNonEmptyString(
      record["description"],
      `evidenceRequirements[${index}].description`,
    ),
  };
}

function requireStepInput(
  input: unknown,
  index: number,
): {
  stepId: string;
  dependsOn: string[];
  allowedWorkerRefs: string[];
  prohibitedActions: string[];
  requiredGateRefs: string[];
  requiredEvidenceRefs: string[];
  recovery: string;
} {
  if (typeof input !== "object" || input === null) {
    throw new InvalidDeliveryRecipeError(`steps[${index}] must be an object`);
  }
  const record = input as Record<string, unknown>;
  const recovery = record["recovery"];
  if (typeof recovery !== "string" || !RECOVERY_VALUES.has(recovery)) {
    throw new InvalidDeliveryRecipeError(
      `steps[${index}].recovery must be one of ${Array.from(RECOVERY_VALUES).join(", ")}`,
    );
  }
  return {
    stepId: requireNonEmptyString(record["stepId"], `steps[${index}].stepId`),
    dependsOn: requireStringArray(record["dependsOn"] ?? [], `steps[${index}].dependsOn`),
    allowedWorkerRefs: requireStringArray(
      record["allowedWorkerRefs"] ?? [],
      `steps[${index}].allowedWorkerRefs`,
    ),
    prohibitedActions: requireStringArray(
      record["prohibitedActions"] ?? [],
      `steps[${index}].prohibitedActions`,
    ),
    requiredGateRefs: requireStringArray(
      record["requiredGateRefs"] ?? [],
      `steps[${index}].requiredGateRefs`,
    ),
    requiredEvidenceRefs: requireStringArray(
      record["requiredEvidenceRefs"] ?? [],
      `steps[${index}].requiredEvidenceRefs`,
    ),
    recovery,
  };
}

/**
 * D1-D9 structural validation, in the same style as
 * `createOfferBlueprintVersion` (T5): reject dangling references and
 * dependency cycles at construction time, not at some later consumption
 * point.
 */
export function createDeliveryRecipe(input: {
  recipeId: unknown;
  version: unknown;
  jobFamily: unknown;
  requiredCapabilityRefs?: unknown;
  requiredContextRefs?: unknown;
  policyRefs?: unknown;
  gates: unknown;
  evidenceRequirements: unknown;
  steps: unknown;
  completionRequirements?: unknown;
}): DeliveryRecipe {
  const recipeId = requireNonEmptyString(input.recipeId, "recipeId");
  const version = requirePositiveInteger(input.version, "version");
  const jobFamily = requireNonEmptyString(input.jobFamily, "jobFamily");
  const requiredCapabilityRefs = requireStringArray(
    input.requiredCapabilityRefs ?? [],
    "requiredCapabilityRefs",
  );
  const requiredContextRefs = requireStringArray(
    input.requiredContextRefs ?? [],
    "requiredContextRefs",
  );
  const policyRefs = requireStringArray(input.policyRefs ?? [], "policyRefs");

  if (!Array.isArray(input.gates)) {
    throw new InvalidDeliveryRecipeError("gates must be an array");
  }
  const gates = input.gates.map((g, i) => requireGateInput(g, i));
  const gateIds = new Set<string>();
  for (const gate of gates) {
    if (gateIds.has(gate.gateId)) {
      throw new InvalidDeliveryRecipeError(`duplicate gateId "${gate.gateId}"`);
    }
    gateIds.add(gate.gateId);
  }

  if (!Array.isArray(input.evidenceRequirements)) {
    throw new InvalidDeliveryRecipeError("evidenceRequirements must be an array");
  }
  const evidenceRequirements = input.evidenceRequirements.map((e, i) =>
    requireEvidenceRequirementInput(e, i),
  );
  const evidenceRequirementIds = new Set<string>();
  for (const req of evidenceRequirements) {
    if (evidenceRequirementIds.has(req.requirementId)) {
      throw new InvalidDeliveryRecipeError(
        `duplicate evidence requirementId "${req.requirementId}"`,
      );
    }
    evidenceRequirementIds.add(req.requirementId);
  }

  if (!Array.isArray(input.steps)) {
    throw new InvalidDeliveryRecipeError("steps must be an array");
  }
  if (input.steps.length === 0) {
    throw new InvalidDeliveryRecipeError("steps must not be empty");
  }
  const steps = input.steps.map((s, i) => requireStepInput(s, i));

  // D2: unique step ids.
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.stepId)) {
      throw new InvalidDeliveryRecipeError(`duplicate stepId "${step.stepId}"`);
    }
    stepIds.add(step.stepId);
  }

  // D3: dependsOn must resolve to a known step.
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        throw new InvalidDeliveryRecipeError(
          `step "${step.stepId}" depends on unknown stepId "${dep}"`,
        );
      }
    }
  }

  // D5: gate/evidence references must resolve.
  for (const step of steps) {
    for (const gateRef of step.requiredGateRefs) {
      if (!gateIds.has(gateRef)) {
        throw new InvalidDeliveryRecipeError(
          `step "${step.stepId}" references unknown gateId "${gateRef}"`,
        );
      }
    }
    for (const evidenceRef of step.requiredEvidenceRefs) {
      if (!evidenceRequirementIds.has(evidenceRef)) {
        throw new InvalidDeliveryRecipeError(
          `step "${step.stepId}" references unknown evidence requirementId "${evidenceRef}"`,
        );
      }
    }
  }

  // D4: dependency graph must be acyclic.
  const dependencyMap = new Map<string, ReadonlyArray<string>>(
    steps.map((step) => [step.stepId, step.dependsOn]),
  );
  const VISITING = 1;
  const DONE = 2;
  const state = new Map<string, number>();
  const detectCycle = (id: string, path: string[]): void => {
    const status = state.get(id);
    if (status === DONE) {
      return;
    }
    if (status === VISITING) {
      throw new InvalidDeliveryRecipeError(
        `dependency cycle detected: ${[...path, id].join(" -> ")}`,
      );
    }
    state.set(id, VISITING);
    for (const dep of dependencyMap.get(id) ?? []) {
      detectCycle(dep, [...path, id]);
    }
    state.set(id, DONE);
  };
  for (const step of steps) {
    detectCycle(step.stepId, []);
  }

  const completionRequirements = requireStringArray(
    input.completionRequirements ?? [],
    "completionRequirements",
  );
  for (const req of completionRequirements) {
    if (!evidenceRequirementIds.has(req)) {
      throw new InvalidDeliveryRecipeError(
        `completionRequirements references unknown evidence requirementId "${req}"`,
      );
    }
  }

  return {
    recipeId: recipeId as RecipeId,
    version,
    jobFamily,
    requiredCapabilityRefs,
    requiredContextRefs,
    policyRefs,
    gates: gates.map((g) => ({ gateId: g.gateId as GateId, type: g.type })),
    evidenceRequirements: evidenceRequirements.map((e) => ({
      requirementId: e.requirementId as EvidenceRequirementId,
      evidenceClass: e.evidenceClass,
      description: e.description,
    })),
    steps: steps.map((s) => ({
      stepId: s.stepId as StepId,
      dependsOn: s.dependsOn.map((d) => d as StepId),
      allowedWorkerRefs: s.allowedWorkerRefs,
      prohibitedActions: s.prohibitedActions,
      requiredGateRefs: s.requiredGateRefs.map((g) => g as GateId),
      requiredEvidenceRefs: s.requiredEvidenceRefs.map((e) => e as EvidenceRequirementId),
      recovery: s.recovery as RecoverySemantics,
    })),
    completionRequirements: completionRequirements.map((r) => r as EvidenceRequirementId),
  };
}
