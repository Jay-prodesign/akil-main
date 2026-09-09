import { createTenantScope, type TenantScope } from "../domain/tenant-scope.js";
import { createCustomer, type Customer } from "../domain/customer.js";
import {
  createCommercialOrder,
  resolveCanonicalServiceFromOrder,
  type CommercialOrder,
  type ServiceCatalogEntry,
  type CanonicalServiceResolution,
} from "../domain/commercial-order.js";
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
  readonly resolution: CanonicalServiceResolution;
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
  const resolution = resolveCanonicalServiceFromOrder(order, WEBSITE_BUILD_V1_SERVICE_CATALOG);
  return { tenantScope, customer, order, resolution };
}
