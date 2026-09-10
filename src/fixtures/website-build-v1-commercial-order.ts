import { createTenantScope, type TenantScope } from "../domain/tenant-scope.js";
import { createCustomer, type Customer } from "../domain/customer.js";
import { createProject, type Project } from "../domain/project.js";
import type { SoldScope } from "../domain/sold-scope.js";
import type { ProjectPlanVersion } from "../domain/project-plan.js";
import { compilePlan } from "../domain/project-plan.js";
import { validatePlan, type PlanValidationResult } from "../domain/project-plan-validation.js";
import {
  createCommercialOrder,
  resolveDeclaredServiceFromOrder,
  type CommercialOrder,
  type ServiceCatalogEntry,
  type DeclaredServiceLookupResult,
} from "../domain/commercial-order.js";
import { intakeSoldScopeFromResolution } from "../domain/commercial-order-intake.js";
import { WEBSITE_BUILD_V1_BLUEPRINT } from "./website-build-v1.js";
import { WEBSITE_BUILD_V1_RECIPE } from "./website-build-v1-recipe.js";

/**
 * Reuses the WEBSITE_BUILD_v1 blueprint/recipe identifiers verbatim as the
 * one catalog entry for this reference proof - no second product/service
 * concept invented alongside them.
 */
export const WEBSITE_BUILD_V1_SERVICE_CATALOG: ReadonlyArray<ServiceCatalogEntry> = [
  {
    serviceRef: "service:website-build",
    blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
    blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
    recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
  },
];

export interface WebsiteBuildV1CommercialOrderFixture {
  readonly tenantScope: TenantScope;
  readonly customer: Customer;
  readonly order: CommercialOrder;
  readonly resolution: DeclaredServiceLookupResult;
}

/**
 * A zero-history commercial order (Rev62 AUD-V5-GAP-02): no Project, no
 * SoldScope, no evidence exists yet at this point - only a tenant, a
 * customer, and an order for `"service:website-build"`. Resolving it
 * against `WEBSITE_BUILD_V1_SERVICE_CATALOG` is the first proven edge of
 * the Cold-Start First Customer chain; everything downstream (project
 * bootstrap, SoldScope, plan compilation) remains this repository's
 * existing, separately-tested machinery, consumed from the resolution
 * output rather than duplicated here.
 */
export function buildWebsiteBuildV1CommercialOrderFixture(): WebsiteBuildV1CommercialOrderFixture {
  const tenantScope = createTenantScope("tenant-website-build-v1-order");
  const customer = createCustomer({
    tenantScope,
    customerId: "cust-website-build-v1-order",
    displayName: "Reference Order Customer Co",
  });
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-website-build-v1",
    serviceRef: "service:website-build",
    placedAt: "2026-09-09T00:00:00.000Z",
  });
  const resolution = resolveDeclaredServiceFromOrder(order, WEBSITE_BUILD_V1_SERVICE_CATALOG);
  return { tenantScope, customer, order, resolution };
}

export interface WebsiteBuildV1ColdStartFixture {
  readonly tenantScope: TenantScope;
  readonly customer: Customer;
  readonly order: CommercialOrder;
  readonly resolution: DeclaredServiceLookupResult;
  readonly project: Project;
  readonly soldScope: SoldScope;
  readonly plan: ProjectPlanVersion;
  readonly planValidation: PlanValidationResult;
}

/**
 * The full Rev62 AUD-V5-GAP-02 Cold-Start chain proven end to end from one
 * zero-history order: order -> canonical service resolution -> intake
 * (order-driven `SoldScope` compilation, fail-closed bound to the resolved
 * blueprint identity) -> plan compilation -> structural completeness
 * ("Brief Completeness / Readiness"). Project creation itself is not
 * bootstrap-template-driven here (`project-bootstrap-template.ts`/
 * V5-BOOT-001 remains a separate, already-tested concern, deliberately not
 * composed into this proof) - this fixture creates the project directly,
 * the same way every other fixture in this repository does, to isolate
 * the order/intake/compile chain from bootstrap-template concerns.
 * Evidence-based admission readiness (`evaluateReadiness`/`admitPlan`,
 * which require caller-supplied customer evidence) remains explicitly out
 * of scope - this fixture proves only that the compiled plan is
 * structurally `COMPLETE`, not that it is admitted.
 */
export function buildWebsiteBuildV1ColdStartFixture(): WebsiteBuildV1ColdStartFixture {
  const tenantScope = createTenantScope("tenant-website-build-v1-cold-start");
  const customer = createCustomer({
    tenantScope,
    customerId: "cust-website-build-v1-cold-start",
    displayName: "Cold-Start Reference Customer Co",
  });
  const order = createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-website-build-v1-cold-start",
    serviceRef: "service:website-build",
    placedAt: "2026-09-09T00:00:00.000Z",
  });
  const resolution = resolveDeclaredServiceFromOrder(order, WEBSITE_BUILD_V1_SERVICE_CATALOG);
  const project = createProject({
    tenantScope,
    customer,
    projectId: "proj-website-build-v1-cold-start",
    ownerRef: "owner-website-build-v1-cold-start",
    state: "active",
  });
  const soldScope = intakeSoldScopeFromResolution({
    tenantScope,
    project,
    resolution,
    blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
    soldScopeId: "sold-scope-website-build-v1-cold-start",
    outcomeContractRef: "outcome-contract-website-build-v1-cold-start",
    includedRequirementIds: ["optional-multilingual-content"],
    excludedRequirementIds: ["optional-ecommerce-integration"],
  });
  const plan = compilePlan({
    tenantScope,
    project,
    planId: "plan-website-build-v1-cold-start",
    blueprint: WEBSITE_BUILD_V1_BLUEPRINT,
    soldScope,
    now: "2026-09-09T00:00:00.000Z",
  });
  const planValidation = validatePlan(plan, WEBSITE_BUILD_V1_BLUEPRINT);
  return { tenantScope, customer, order, resolution, project, soldScope, plan, planValidation };
}
