import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOfferBlueprintVersion } from "../src/domain/offer-blueprint.js";
import {
  intakeSoldScopeFromResolution,
  InvalidCommercialOrderIntakeError,
} from "../src/domain/commercial-order-intake.js";
import type { ServiceCatalogEntry } from "../src/domain/commercial-order.js";
import {
  admitServiceCatalogEntry,
  revokeServiceCatalogAdmission,
  type TrustedServiceResolution,
} from "../src/domain/service-catalog-admission.js";
import type { AdmittedWorker } from "../src/domain/worker-routing-policy.js";
import { WEBSITE_BUILD_V1_BLUEPRINT } from "../src/fixtures/website-build-v1.js";
import {
  buildWebsiteBuildV1ColdStartFixture,
  WEBSITE_BUILD_V1_SERVICE_CATALOG,
} from "../src/fixtures/website-build-v1-commercial-order.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";
import { validatePlan } from "../src/domain/project-plan-validation.js";

const tenantScope = createTenantScope("tenant-a");
const customer = createCustomer({ tenantScope, customerId: "cust-1", displayName: "Acme" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});

const elevatedWorker: AdmittedWorker = {
  workerId: "authority-intake-test",
  declaredCapabilityRefs: [],
  declaredToolRefs: [],
  declaredPolicyConstraintRefs: [],
  trustStatus: "ADMITTED",
  availability: "AVAILABLE",
  maxRiskLevel: "STANDARD",
  authorityLevel: "ELEVATED",
  costWeight: 0,
  evaluationEvidenceRef: "evidence:intake-test-worker-eval",
};

const catalogEntry: ServiceCatalogEntry = {
  serviceRef: "service:website-build",
  blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
  blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
  recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
  executionRoutingPolicy: "MANUAL_EXECUTION_ALLOWED",
};

// Built through the real `admitServiceCatalogEntry` gate (never a
// hand-built literal), so every RESOLVED case below is proven against a
// structurally-reachable admission.
const admission = admitServiceCatalogEntry({
  catalogEntry,
  recipe: WEBSITE_BUILD_V1_RECIPE,
  authorizingWorker: elevatedWorker,
  evidenceRef: "evidence:intake-test-catalog-admission",
  admittedAt: "2026-01-01T00:00:00.000Z",
});

const resolvedForBlueprint: TrustedServiceResolution = {
  status: "RESOLVED",
  admission,
};

test("intakeSoldScopeFromResolution builds a SoldScope when the blueprint matches the resolution exactly", () => {
  const soldScope = intakeSoldScopeFromResolution({
    tenantScope,
    project,
    resolution: resolvedForBlueprint,
    blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
  });
  assert.equal(soldScope.tenantId, "tenant-a");
  assert.equal(soldScope.projectId, "proj-1");
  assert.equal(soldScope.soldScopeId, "scope-1");
});

test("intakeSoldScopeFromResolution forwards included/excludedRequirementIds unchanged", () => {
  const soldScope = intakeSoldScopeFromResolution({
    tenantScope,
    project,
    resolution: resolvedForBlueprint,
    blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
    soldScopeId: "scope-1",
    outcomeContractRef: "contract-1",
    includedRequirementIds: ["optional-multilingual-content"],
    excludedRequirementIds: ["optional-ecommerce-integration"],
  });
  assert.deepEqual(soldScope.includedRequirementIds, ["optional-multilingual-content"]);
  assert.deepEqual(soldScope.excludedRequirementIds, ["optional-ecommerce-integration"]);
});

test("rejects intake for an UNRESOLVED_SERVICE resolution", () => {
  const unresolved: TrustedServiceResolution = {
    status: "UNRESOLVED_SERVICE",
    reason: "no catalog entry",
  };
  assert.throws(
    () =>
      intakeSoldScopeFromResolution({
        tenantScope,
        project,
        resolution: unresolved,
        blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
        soldScopeId: "scope-1",
        outcomeContractRef: "contract-1",
      }),
    InvalidCommercialOrderIntakeError,
  );
});

test("rejects intake for a NOT_ADMITTED resolution (declared-resolvable service with no backing catalog admission)", () => {
  const notAdmitted: TrustedServiceResolution = {
    status: "NOT_ADMITTED",
    serviceRef: "service:website-build",
    reason: "no currently-ADMITTED ServiceCatalogAdmission covers this service",
  };
  assert.throws(
    () =>
      intakeSoldScopeFromResolution({
        tenantScope,
        project,
        resolution: notAdmitted,
        blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
        soldScopeId: "scope-1",
        outcomeContractRef: "contract-1",
      }),
    InvalidCommercialOrderIntakeError,
  );
});

test("rejects intake for a RESOLVED resolution whose own admission has since been revoked - a RESOLVED disposition computed earlier is never itself a live guarantee", () => {
  // TrustedServiceResolution is a plain structural type, not branded: a
  // caller can hand-build a RESOLVED value wrapping an admission whose own
  // status has moved on since the resolution was computed. Proves C8's
  // real gap - not just that the type system now requires a
  // TrustedServiceResolution shape, but that intake re-checks the
  // admission's own CURRENT status, exactly like every other consumer of
  // a ServiceCatalogAdmission in this repository.
  const revoked = revokeServiceCatalogAdmission({
    admission,
    revokedAt: "2026-01-02T00:00:00.000Z",
    reason: "catalog entry withdrawn",
  });
  const resolvedWithRevokedAdmission: TrustedServiceResolution = {
    status: "RESOLVED",
    admission: revoked,
  };
  assert.throws(
    () =>
      intakeSoldScopeFromResolution({
        tenantScope,
        project,
        resolution: resolvedWithRevokedAdmission,
        blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
        soldScopeId: "scope-1",
        outcomeContractRef: "contract-1",
      }),
    InvalidCommercialOrderIntakeError,
  );
});

test("rejects intake when the supplied blueprint's blueprintId does not match the resolution's admission", () => {
  assert.notEqual("other-blueprint", admission.blueprintId);
  const otherBlueprint = createOfferBlueprintVersion({
    blueprintId: "other-blueprint",
    version: admission.blueprintVersion,
    requirements: [
      { requirementId: "r1", description: "r1", necessity: "REQUIRED", dependsOn: [] },
    ],
  });
  assert.throws(
    () =>
      intakeSoldScopeFromResolution({
        tenantScope,
        project,
        resolution: resolvedForBlueprint,
        blueprint: otherBlueprint,
        soldScopeId: "scope-1",
        outcomeContractRef: "contract-1",
      }),
    InvalidCommercialOrderIntakeError,
  );
});

test("rejects intake when the supplied blueprint's version does not match the resolution's admitted blueprintVersion", () => {
  assert.notEqual("999.0.0", admission.blueprintVersion);
  const wrongVersionBlueprint = createOfferBlueprintVersion({
    blueprintId: admission.blueprintId,
    version: "999.0.0",
    requirements: [
      { requirementId: "r1", description: "r1", necessity: "REQUIRED", dependsOn: [] },
    ],
  });
  assert.throws(
    () =>
      intakeSoldScopeFromResolution({
        tenantScope,
        project,
        resolution: resolvedForBlueprint,
        blueprint: wrongVersionBlueprint,
        soldScopeId: "scope-1",
        outcomeContractRef: "contract-1",
      }),
    InvalidCommercialOrderIntakeError,
  );
});

test("rejects a project that does not belong to the given tenantScope (delegated to createSoldScope, not duplicated)", () => {
  const otherTenantScope = createTenantScope("tenant-b");
  assert.throws(() =>
    intakeSoldScopeFromResolution({
      tenantScope: otherTenantScope,
      project,
      resolution: resolvedForBlueprint,
      blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
      soldScopeId: "scope-1",
      outcomeContractRef: "contract-1",
    }),
  );
});

test("WEBSITE_BUILD_v1 Cold-Start fixture proves the full chain: zero-history order -> resolution -> intake -> compiled, structurally COMPLETE plan", () => {
  const fixture = buildWebsiteBuildV1ColdStartFixture();
  assert.equal(fixture.resolution.status, "RESOLVED");
  assert.equal(fixture.soldScope.tenantId, fixture.tenantScope.tenantId);
  assert.equal(fixture.soldScope.projectId, fixture.project.projectId);
  assert.equal(fixture.plan.tenantId, fixture.tenantScope.tenantId);
  assert.equal(fixture.plan.sourceBlueprintId, WEBSITE_BUILD_V1_BLUEPRINT.blueprintId);
  assert.equal(fixture.planValidation.status, "COMPLETE");
  assert.deepEqual(fixture.planValidation.findings, []);
});

test("WEBSITE_BUILD_v1 Cold-Start fixture's compiled plan independently re-validates as COMPLETE", () => {
  const fixture = buildWebsiteBuildV1ColdStartFixture();
  const reValidated = validatePlan(fixture.plan, WEBSITE_BUILD_V1_BLUEPRINT);
  assert.equal(reValidated.status, "COMPLETE");
});

test("WEBSITE_BUILD_V1_SERVICE_CATALOG entry's blueprintVersion matches the canonical blueprint used for intake", () => {
  assert.equal(WEBSITE_BUILD_V1_SERVICE_CATALOG[0]?.blueprintVersion, WEBSITE_BUILD_V1_BLUEPRINT.version);
});
