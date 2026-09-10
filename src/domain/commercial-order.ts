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
 * resolving it (see `resolveDeclaredServiceFromOrder` below) is a
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
 * specific `OfferBlueprintVersion` + `DeliveryRecipe` that fulfills it.
 * Not a real service catalog/product/SKU system - this repository has
 * none - just the minimum reusable pointer a lookup needs, reusing the
 * existing blueprintId/version/recipeId identifiers verbatim rather than
 * inventing a parallel "product" concept.
 *
 * Rev74 F1 claim-boundary correction (Brain CHANGES_REQUIRED): this catalog
 * carries no admission, provenance, or authority binding of its own - it is
 * whatever `ReadonlyArray<ServiceCatalogEntry>` the caller passes to
 * `resolveDeclaredServiceFromOrder`. Nothing in this module verifies that
 * a given entry was ever admitted through a trusted, repository-native
 * boundary; a caller can construct an arbitrary entry (any `serviceRef`
 * paired with any `blueprintId`/`blueprintVersion`/`recipeId`) and it
 * resolves identically to one that reflects a real, admitted service
 * offering. A repository-wide search found no existing admitted/trusted
 * catalog authority/provenance primitive to bind this to (the closest
 * candidates, `OfferBlueprintVersion`/`DeliveryRecipe`, are validated
 * *construction* domain objects, not an admission/provenance system), and
 * building one here would be exactly the "second catalog/orchestration
 * system" Brain's own acceptance forbids. This module therefore does not
 * claim canonical/trusted resolution - see `resolveDeclaredServiceFromOrder`
 * below for the precise, honest scope.
 *
 * Rev77 correction (Brain CHANGES_REQUIRED): the Rev74 doc-comment
 * narrowing above was honest, but the public API's own *names* -
 * previously `CanonicalServiceResolution`/`resolveCanonicalServiceFromOrder`
 * - still embedded the disproven canonical claim regardless of what the
 * prose beside them said. Renamed to `DeclaredServiceLookupResult`/
 * `resolveDeclaredServiceFromOrder`: "declared" names what this actually
 * is (a caller-declared catalog lookup), not what it is not (canonical/
 * trusted resolution). No behavior changed - this is a naming-only
 * correction; the canonical-resolution provenance gap remains explicitly
 * OPEN, as before.
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
 * case where a customer's requested `serviceRef` has no matching catalog
 * entry yet. Neither disposition is proof that the matched entry (if any)
 * came from an admitted, trusted source - see the Rev74 correction note on
 * `ServiceCatalogEntry` and `resolveDeclaredServiceFromOrder`.
 */
export type DeclaredServiceLookupResult =
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
 * Deterministic, pure lookup of a CommercialOrder's opaque `serviceRef`
 * against a caller-supplied catalog (Rev62 AUD-V5-GAP-02, "Commercial
 * Order -> Canonical Service Resolution"). Fails closed - never guesses a
 * "closest" match:
 * - no catalog entry declares the order's `serviceRef` -> `UNRESOLVED_SERVICE`.
 * - more than one catalog entry declares the same `serviceRef` -> thrown
 *   error (ambiguous catalog is a caller/data-integrity defect, not a
 *   normal runtime disposition - same "throw rather than guess" discipline
 *   already used by `resolveCurrentOwner`, V3-OWN-001).
 *
 * Rev74 F1 claim-boundary correction (Brain CHANGES_REQUIRED): despite this
 * function's name, `RESOLVED` is **not** proof of canonical/trusted
 * resolution - it only proves the caller's own catalog contains exactly one
 * entry for the order's `serviceRef`. There is no admission, provenance, or
 * authority check anywhere in this call: a caller-fabricated catalog entry
 * (a `serviceRef` paired with an arbitrary `blueprintId`/`blueprintVersion`/
 * `recipeId` that was never admitted anywhere) resolves exactly as a real,
 * admitted one would. This is honestly scoped as **deterministic
 * caller-supplied lookup only**. Closing the real canonical-resolution
 * audit gap - binding catalog entries to an admitted/trusted
 * repository-native provenance boundary before trusting their resolution -
 * remains an explicitly OPEN gap; this repository has no such boundary to
 * bind to yet, and inventing one here would itself be the "second
 * catalog/orchestration system" out of scope for this checkpoint.
 */
export function resolveDeclaredServiceFromOrder(
  order: CommercialOrder,
  catalog: ReadonlyArray<ServiceCatalogEntry>,
): DeclaredServiceLookupResult {
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
