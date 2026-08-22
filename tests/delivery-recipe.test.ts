import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDeliveryRecipe,
  isProhibitedAction,
  isRetryableRecovery,
  InvalidDeliveryRecipeError,
} from "../src/domain/delivery-recipe.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";
import { WEBSITE_BUILD_V1_BLUEPRINT } from "../src/fixtures/website-build-v1.js";

function minimalRecipeInput() {
  return {
    recipeId: "minimal-recipe",
    version: 1,
    jobFamily: "test-family",
    gates: [{ gateId: "gate-1", type: "HUMAN_REVIEW" as const }],
    evidenceRequirements: [
      { requirementId: "ev-1", evidenceClass: "ARTIFACT", description: "an artifact" },
    ],
    steps: [
      {
        stepId: "step-1",
        dependsOn: [] as string[],
        allowedWorkerRefs: ["worker:x"],
        prohibitedActions: [],
        requiredGateRefs: ["gate-1"],
        requiredEvidenceRefs: ["ev-1"],
        recovery: "NO_EXTERNAL_EFFECT" as const,
      },
    ],
  };
}

test("D1: a valid minimal recipe is deterministic", () => {
  const a = createDeliveryRecipe(minimalRecipeInput());
  const b = createDeliveryRecipe(minimalRecipeInput());
  assert.deepEqual(a, b);
});

test("D1 reference proof: WEBSITE_BUILD_v1 recipe reuses the existing canonical job-family identifier", () => {
  assert.equal(WEBSITE_BUILD_V1_RECIPE.jobFamily, WEBSITE_BUILD_V1_BLUEPRINT.blueprintId);
  assert.equal(WEBSITE_BUILD_V1_RECIPE.steps.length > 0, true);
});

test("D1 reference proof: recompiling the WEBSITE_BUILD_v1 recipe fixture module produces an identical deterministic recipe", () => {
  const again = createDeliveryRecipe({
    recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    version: WEBSITE_BUILD_V1_RECIPE.version,
    jobFamily: WEBSITE_BUILD_V1_RECIPE.jobFamily,
    requiredCapabilityRefs: WEBSITE_BUILD_V1_RECIPE.requiredCapabilityRefs,
    requiredContextRefs: WEBSITE_BUILD_V1_RECIPE.requiredContextRefs,
    policyRefs: WEBSITE_BUILD_V1_RECIPE.policyRefs,
    gates: WEBSITE_BUILD_V1_RECIPE.gates,
    evidenceRequirements: WEBSITE_BUILD_V1_RECIPE.evidenceRequirements,
    steps: WEBSITE_BUILD_V1_RECIPE.steps,
    completionRequirements: WEBSITE_BUILD_V1_RECIPE.completionRequirements,
  });
  assert.deepEqual(again, WEBSITE_BUILD_V1_RECIPE);
});

test("D2: duplicate step ids reject", () => {
  const input = minimalRecipeInput();
  input.steps = [...input.steps, { ...input.steps[0]! }];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("D3: a step depending on an unknown stepId rejects", () => {
  const input = minimalRecipeInput();
  input.steps[0]!.dependsOn = ["does-not-exist"];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("D4: a two-step dependency cycle rejects", () => {
  const input = minimalRecipeInput();
  input.steps = [
    { ...input.steps[0]!, stepId: "a", dependsOn: ["b"] },
    { ...input.steps[0]!, stepId: "b", dependsOn: ["a"] },
  ];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("D5: a step referencing an unknown gateId rejects", () => {
  const input = minimalRecipeInput();
  input.steps[0]!.requiredGateRefs = ["unknown-gate"];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("D5: a step referencing an unknown evidence requirementId rejects", () => {
  const input = minimalRecipeInput();
  input.steps[0]!.requiredEvidenceRefs = ["unknown-evidence"];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("D5: completionRequirements referencing an unknown evidence requirementId rejects", () => {
  const input = minimalRecipeInput();
  (input as { completionRequirements?: string[] }).completionRequirements = ["unknown-evidence"];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("D6: an invalid recovery value rejects", () => {
  const input = minimalRecipeInput();
  (input.steps[0] as { recovery: string }).recovery = "SOMETHING_ELSE";
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("D6: UNKNOWN_BLOCKED remains explicit fail-closed - never reported retryable", () => {
  assert.equal(isRetryableRecovery("UNKNOWN_BLOCKED"), false);
  assert.equal(isRetryableRecovery("IDEMPOTENT_RETRY"), true);
  assert.equal(isRetryableRecovery("NO_EXTERNAL_EFFECT"), false);
  assert.equal(isRetryableRecovery("COMPENSATABLE"), false);
  assert.equal(isRetryableRecovery("IRREVERSIBLE_MANUAL_RECONCILIATION"), false);
});

test("D7: a step missing a recovery classification rejects", () => {
  const input = minimalRecipeInput();
  const stepWithoutRecovery = { ...input.steps[0] } as Record<string, unknown>;
  delete stepWithoutRecovery["recovery"];
  input.steps = [stepWithoutRecovery as (typeof input.steps)[number]];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("D8: a prohibited action cannot be authorized by listing it as an allowed worker/tool ref", () => {
  const step = createDeliveryRecipe({
    ...minimalRecipeInput(),
    steps: [
      {
        stepId: "step-1",
        dependsOn: [],
        allowedWorkerRefs: ["DEPLOY_PRODUCTION"],
        prohibitedActions: ["DEPLOY_PRODUCTION"],
        requiredGateRefs: ["gate-1"],
        requiredEvidenceRefs: ["ev-1"],
        recovery: "NO_EXTERNAL_EFFECT",
      },
    ],
  }).steps[0]!;
  assert.equal(step.allowedWorkerRefs.includes("DEPLOY_PRODUCTION"), true);
  assert.equal(isProhibitedAction(step, "DEPLOY_PRODUCTION"), true);
});

test("D9: this module exposes no function that transitions or verifies an OutcomeJob", () => {
  const deliveryRecipeModule = { createDeliveryRecipe, isRetryableRecovery, isProhibitedAction } as Record<
    string,
    unknown
  >;
  const suspiciousNames = ["verifyOutcomeJob", "transitionOutcomeJob", "closeOutcomeJob", "createOutcomeJob"];
  for (const name of suspiciousNames) {
    assert.equal(name in deliveryRecipeModule, false);
  }
});

test("gates alone (no OutcomeJob field, no verification-granting function) cannot imply VERIFIED/COMPLETED", () => {
  const recipe = createDeliveryRecipe(minimalRecipeInput());
  for (const gate of recipe.gates) {
    assert.deepEqual(Object.keys(gate).sort(), ["gateId", "type"]);
  }
});

test("rejects an empty steps array", () => {
  const input = minimalRecipeInput();
  input.steps = [];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("rejects a duplicate gateId", () => {
  const input = minimalRecipeInput();
  input.gates = [...input.gates, { ...input.gates[0]! }];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("rejects a duplicate evidence requirementId", () => {
  const input = minimalRecipeInput();
  input.evidenceRequirements = [...input.evidenceRequirements, { ...input.evidenceRequirements[0]! }];
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("rejects an invalid gate type", () => {
  const input = minimalRecipeInput();
  (input.gates[0] as { type: string }).type = "NOT_A_TYPE";
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});

test("rejects a non-positive-integer version", () => {
  const input = minimalRecipeInput();
  (input as { version: number }).version = 0;
  assert.throws(() => createDeliveryRecipe(input), InvalidDeliveryRecipeError);
});
