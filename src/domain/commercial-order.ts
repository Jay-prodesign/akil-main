import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { OfferBlueprintVersion } from "./offer-blueprint.js";
import type { DeliveryRecipe } from "./delivery-recipe.js";

export class InvalidCommercialOrderError extends Error {
  constructor(reason: string) {
    super(`Invalid CommercialOrder: ${reason}`);
    this.name = "InvalidCommercialOrderError";
  }
}

type OrderId = string & { readonly __brand: "OrderId" };

/**
 * A customer's placed order for a named service, identified only by an
 * opaque `serviceRef` (Rev62 AUD-V5-GAP-02: "Commercial Order -> Canonical
 * Service Resolution" was MISSING on audited main - this repository's
 * WEBSITE_BUILD_v1 proof starts from a preconstructed Project/SoldScope,
 * never from a zero-history customer order). Deliberately has no
 * `projectId`: an order is the entry point that precedes any Project -
 * resolving it (see `resolveCanonicalServiceFromOrder` below) is a
 * prerequisite input to later project/sold-scope creation, not a
 * consequence of it. No price, discount, payout, or commission field
 * exists on this type - this repository has no real commerce/payment/
 * pricing-policy integration (DEC-146/153), so this floor cannot and does
 * not carry one.
 */
export interface CommercialOrder {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly orderId: OrderId;
  readonly serviceRef: string;
  readonly placedAt: string;
}

/**
 * A caller-declared mapping from an opaque commercial `serviceRef` to the
 * canonical `OfferBlueprintVersion` + `DeliveryRecipe` that fulfills it.
 * Not a real service catalog/product/SKU system - this repository has
 * none - just the minimum reusable pointer a resolver needs, reusing the
 * existing blueprintId/version/recipeId identifiers verbatim rather than
 * inventing a parallel "product" concept.
 */
export interface ServiceCatalogEntry {
  readonly serviceRef: string;
  readonly blueprintId: OfferBlueprintVersion["blueprintId"];
  readonly blueprintVersion: OfferBlueprintVersion["version"];
  readonly recipeId: DeliveryRecipe["recipeId"];
}

/**
 * `UNRESOLVED_SERVICE` is a first-class, honest disposition - never a
 * thrown error and never a fabricated "closest match" - for the ordinary
 * case where a customer's requested `serviceRef` has no admitted catalog
 * entry yet.
 */
export type CanonicalServiceResolution =
  | {
      readonly status: "RESOLVED";
      readonly blueprintId: OfferBlueprintVersion["blueprintId"];
      readonly blueprintVersion: OfferBlueprintVersion["version"];
      readonly recipeId: DeliveryRecipe["recipeId"];
    }
  | {
      readonly status: "UNRESOLVED_SERVICE";
      readonly reason: string;
    };

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidCommercialOrderError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidCommercialOrderError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidCommercialOrderError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidCommercialOrderError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

export function createCommercialOrder(input: {
  tenantScope: TenantScope;
  customer: Customer;
  orderId: unknown;
  serviceRef: unknown;
  placedAt: unknown;
}): CommercialOrder {
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidCommercialOrderError(
      "customer does not belong to the given tenantScope",
    );
  }
  const orderId = requireNonEmptyString(input.orderId, "orderId");
  const serviceRef = requireNonEmptyString(input.serviceRef, "serviceRef");
  const placedAt = requireNonEmptyString(input.placedAt, "placedAt");
  return {
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    orderId: orderId as OrderId,
    serviceRef,
    placedAt,
  };
}

/**
 * Pure, deterministic resolution of a CommercialOrder's opaque `serviceRef`
 * against a caller-supplied catalog (Rev62 AUD-V5-GAP-02, "Commercial
 * Order -> Canonical Service Resolution"). Fails closed - never guesses a
 * "closest" match:
 * - no catalog entry declares the order's `serviceRef` -> `UNRESOLVED_SERVICE`.
 * - more than one catalog entry declares the same `serviceRef` -> thrown
 *   error (ambiguous catalog is a caller/data-integrity defect, not a
 *   normal runtime disposition - same "throw rather than guess" discipline
 *   already used by `resolveCurrentOwner`, V3-OWN-001).
 */
export function resolveCanonicalServiceFromOrder(
  order: CommercialOrder,
  catalog: ReadonlyArray<ServiceCatalogEntry>,
): CanonicalServiceResolution {
  const matchCount = catalog.filter((entry) => entry.serviceRef === order.serviceRef).length;
  if (matchCount > 1) {
    throw new InvalidCommercialOrderError(
      `catalog declares serviceRef "${order.serviceRef}" more than once (ambiguous resolution)`,
    );
  }
  const match = catalog.find((entry) => entry.serviceRef === order.serviceRef);
  if (match === undefined) {
    return {
      status: "UNRESOLVED_SERVICE",
      reason: `no catalog entry declares serviceRef "${order.serviceRef}"`,
    };
  }
  return {
    status: "RESOLVED",
    blueprintId: match.blueprintId,
    blueprintVersion: match.blueprintVersion,
    recipeId: match.recipeId,
  };
}
