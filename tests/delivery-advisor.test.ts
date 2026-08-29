import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAdvisorResult,
  InvalidAdvisorContextError,
} from "../src/domain/delivery-advisor.js";
import { buildClientProjectSnapshot } from "../src/domain/client-project-snapshot.js";
import { createCapabilityAdmission } from "../src/domain/capability-admission.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "../src/fixtures/website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT } from "../src/fixtures/website-build-v1-snapshot.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";
import { WEBSITE_BUILD_V1_ADVISOR_RESULT } from "../src/fixtures/website-build-v1-advisor.js";

const fixture = buildWebsiteBuildV1Fixture();

function minimalSnapshot() {
  return buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: [],
  });
}

test("A4/A11 reference proof: WEBSITE_BUILD_v1 advisor result is deterministic, reaches L1_RECOMMEND and cites the applicable recipe", () => {
  const again = buildAdvisorResult({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    snapshot: WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT,
    recipe: WEBSITE_BUILD_V1_RECIPE,
  });
  assert.deepEqual(again, WEBSITE_BUILD_V1_ADVISOR_RESULT);
  assert.equal(WEBSITE_BUILD_V1_ADVISOR_RESULT.status, "RECOMMENDATIONS_AVAILABLE");
  assert.equal(WEBSITE_BUILD_V1_ADVISOR_RESULT.maturity, "L1_RECOMMEND");
  assert.equal(WEBSITE_BUILD_V1_ADVISOR_RESULT.recommendations.length, 1);
  assert.equal(
    WEBSITE_BUILD_V1_ADVISOR_RESULT.recommendations[0]?.basedOnCapabilityRef,
    "required-access-connections",
  );
  assert.deepEqual(WEBSITE_BUILD_V1_ADVISOR_RESULT.observation.applicableRecipeRef, {
    recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
    version: WEBSITE_BUILD_V1_RECIPE.version,
  });
});

test("A4: L0 observation preserves overallStatus/nextAction/eta verbatim from the snapshot, including explicit UNKNOWN eta", () => {
  const snapshot = minimalSnapshot();
  const result = buildAdvisorResult({ ownership: WEBSITE_BUILD_V1_OWNERSHIP, snapshot });
  assert.equal(result.observation.overallStatus, snapshot.deliveryStatus.overallStatus);
  assert.deepEqual(result.observation.nextAction, snapshot.nextAction);
  assert.deepEqual(result.observation.eta, { status: "UNKNOWN" });
  assert.equal(result.observation.verifiedCompletedJobCount, 0);
});

test("A3: cross-tenant/customer/project ownership substitution rejects before any observation/recommendation is constructed", () => {
  const snapshot = minimalSnapshot();
  assert.throws(
    () =>
      buildAdvisorResult({
        ownership: createProjectOwnershipRef({
          tenantId: "some-other-tenant",
          customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
          projectId: WEBSITE_BUILD_V1_OWNERSHIP.projectId,
        }),
        snapshot,
      }),
    InvalidAdvisorContextError,
  );
  assert.throws(
    () =>
      buildAdvisorResult({
        ownership: createProjectOwnershipRef({
          tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
          customerId: "some-other-customer",
          projectId: WEBSITE_BUILD_V1_OWNERSHIP.projectId,
        }),
        snapshot,
      }),
    InvalidAdvisorContextError,
  );
  assert.throws(
    () =>
      buildAdvisorResult({
        ownership: createProjectOwnershipRef({
          tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
          customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
          projectId: "some-other-project",
        }),
        snapshot,
      }),
    InvalidAdvisorContextError,
  );
});

test("A6: zero eligible (VERIFIED_AVAILABLE) capability yields a deterministic UNAVAILABLE result, never a recommendation", () => {
  const snapshot = minimalSnapshot();
  const result = buildAdvisorResult({ ownership: WEBSITE_BUILD_V1_OWNERSHIP, snapshot });
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.maturity, "L0_OBSERVE");
  assert.deepEqual(result.recommendations, []);
  assert.equal(typeof result.unavailableReason, "string");
  assert.equal((result.unavailableReason as string).length > 0, true);
});

test("A5: UNVERIFIED/UNSUPPORTED/INELIGIBLE capabilities are excluded from recommendations and classified into observation-only lists", () => {
  const admissions = [
    createCapabilityAdmission({
      capabilityAdmissionId: "cap-unverified",
      ownership: WEBSITE_BUILD_V1_OWNERSHIP,
      requiredCapabilityRef: "capability:unverified-one",
      status: "UNVERIFIED",
    }),
    createCapabilityAdmission({
      capabilityAdmissionId: "cap-unsupported",
      ownership: WEBSITE_BUILD_V1_OWNERSHIP,
      requiredCapabilityRef: "capability:unsupported-one",
      status: "UNSUPPORTED",
    }),
    createCapabilityAdmission({
      capabilityAdmissionId: "cap-ineligible",
      ownership: WEBSITE_BUILD_V1_OWNERSHIP,
      requiredCapabilityRef: "capability:ineligible-one",
      status: "INELIGIBLE",
    }),
  ];
  const snapshot = buildClientProjectSnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    project: fixture.project,
    jobs: [],
    capabilityAdmissions: admissions,
  });
  const result = buildAdvisorResult({ ownership: WEBSITE_BUILD_V1_OWNERSHIP, snapshot });
  assert.equal(result.status, "UNAVAILABLE");
  assert.deepEqual(result.recommendations, []);
  assert.deepEqual(result.observation.unsupportedCapabilityRefs, ["capability:unsupported-one"]);
  assert.deepEqual(
    [...result.observation.ineligibleCapabilityRefs].sort(),
    ["capability:ineligible-one", "capability:unverified-one"],
  );
});

test("A1/A11: a recipe with a jobFamily absent from the project's own jobs is never cited as applicable provenance", () => {
  const snapshot = minimalSnapshot();
  const result = buildAdvisorResult({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    snapshot,
    recipe: WEBSITE_BUILD_V1_RECIPE,
  });
  assert.equal(result.observation.applicableRecipeRef, undefined);
});

test("A7: this module exports no function other than buildAdvisorResult capable of producing an AdvisorResult (no mutation/approve/execute surface)", async () => {
  const moduleExports = await import("../src/domain/delivery-advisor.js");
  const functionExportNames = Object.keys(moduleExports).filter(
    (key) => typeof (moduleExports as Record<string, unknown>)[key] === "function",
  );
  assert.deepEqual(functionExportNames, ["InvalidAdvisorContextError", "buildAdvisorResult"]);
});

test("A9: AdvisorResult carries only the fields this module defines - no secret/internal/margin field leaks through", () => {
  const forbiddenKeys = ["secret", "credential", "token", "password", "margin", "cost", "prompt"];
  const serialized = JSON.stringify(WEBSITE_BUILD_V1_ADVISOR_RESULT).toLowerCase();
  for (const forbidden of forbiddenKeys) {
    assert.equal(serialized.includes(forbidden), false, `found forbidden key fragment "${forbidden}"`);
  }
});
