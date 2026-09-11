import type { CommercialOrder, ServiceCatalogEntry, DeclaredServiceLookupResult } from "./commercial-order.js";
import type { OfferBlueprintVersion } from "./offer-blueprint.js";
import type { DeliveryRecipe } from "./delivery-recipe.js";

export class InvalidServiceCatalogAdmissionError extends Error {
  constructor(reason: string) {
    super(`Invalid ServiceCatalogAdmission: ${reason}`);
    this.name = "InvalidServiceCatalogAdmissionError";
  }
}

export class InvalidServiceCatalogAdmissionTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid ServiceCatalogAdmission transition: ${reason}`);
    this.name = "InvalidServiceCatalogAdmissionTransitionError";
  }
}

export type ServiceCatalogAdmissionStatus = "ADMITTED" | "REVOKED";

/**
 * Rev98 Family 1: `commercial-order.ts` (`resolveDeclaredServiceFromOrder`)
 * deliberately, honestly stops at a caller-supplied catalog lookup - its own
 * doc comments record that "a caller-fabricated catalog entry ... resolves
 * exactly as a real, admitted one would," and that closing the real
 * canonical-resolution gap remains explicitly OPEN. This module is that
 * closure: an admitted `ServiceCatalogEntry` is one that has actually been
 * through a fail-closed, evidenced admission gate - binding it to the
 * `DeliveryRecipe` it claims to fulfill - before anything downstream may
 * treat a `RESOLVED` lookup as trustworthy. This does not replace or modify
 * `commercial-order.ts`'s own declared lookup; it composes it as one more
 * required check, exactly like `capability-admission.ts`'s
 * `VERIFIED_AVAILABLE` gate composes a `ConnectionBinding`.
 */
export interface ServiceCatalogAdmission {
  readonly serviceRef: ServiceCatalogEntry["serviceRef"];
  readonly blueprintId: OfferBlueprintVersion["blueprintId"];
  readonly blueprintVersion: OfferBlueprintVersion["version"];
  readonly recipeId: DeliveryRecipe["recipeId"];
  readonly status: ServiceCatalogAdmissionStatus;
  readonly admittedByAuthorityId: string;
  readonly evidenceRef: string;
  readonly admittedAt: string;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidServiceCatalogAdmissionError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidServiceCatalogAdmissionError(`${field} must not be empty or whitespace-only`);
  }
  return value;
}

/**
 * The only construction path for a `ServiceCatalogAdmission` - there is no
 * separate "promote" step, matching `capability-admission.ts`'s single
 * fail-closed gate discipline. Fails closed unless `catalogEntry.recipeId`
 * exactly matches the supplied, separately-validated `recipe.recipeId`: an
 * admission can never bind a catalog entry to a recipe it does not actually
 * declare, which would silently re-open the exact provenance gap this
 * module exists to close.
 */
export function admitServiceCatalogEntry(input: {
  catalogEntry: ServiceCatalogEntry;
  recipe: DeliveryRecipe;
  admittedByAuthorityId: unknown;
  evidenceRef: unknown;
  admittedAt: unknown;
}): ServiceCatalogAdmission {
  if (input.catalogEntry.recipeId !== input.recipe.recipeId) {
    throw new InvalidServiceCatalogAdmissionError(
      `catalogEntry.recipeId "${input.catalogEntry.recipeId}" does not match recipe.recipeId "${input.recipe.recipeId}"`,
    );
  }
  const admittedByAuthorityId = requireNonEmptyString(
    input.admittedByAuthorityId,
    "admittedByAuthorityId",
  );
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const admittedAt = requireNonEmptyString(input.admittedAt, "admittedAt");
  return {
    serviceRef: input.catalogEntry.serviceRef,
    blueprintId: input.catalogEntry.blueprintId,
    blueprintVersion: input.catalogEntry.blueprintVersion,
    recipeId: input.catalogEntry.recipeId,
    status: "ADMITTED",
    admittedByAuthorityId,
    evidenceRef,
    admittedAt,
  };
}

/**
 * Terminal, one-way transition - mirrors `partner-capability-admission.ts`'s
 * `revokePartnerCapabilityClaim` (including its Rev62 temporal-integrity
 * fix: `revokedAt` must not predate `admittedAt`; equal is accepted as an
 * immediate revocation, not "before").
 */
export function revokeServiceCatalogAdmission(input: {
  admission: ServiceCatalogAdmission;
  revokedAt: unknown;
  reason: unknown;
}): ServiceCatalogAdmission {
  if (input.admission.status === "REVOKED") {
    throw new InvalidServiceCatalogAdmissionTransitionError(
      "admission is already REVOKED",
    );
  }
  const revokedAt = requireNonEmptyString(input.revokedAt, "revokedAt");
  const reason = requireNonEmptyString(input.reason, "reason");
  if (revokedAt < input.admission.admittedAt) {
    throw new InvalidServiceCatalogAdmissionTransitionError(
      "revokedAt must not be before admittedAt",
    );
  }
  return {
    ...input.admission,
    status: "REVOKED",
    revokedAt,
    revokedReason: reason,
  };
}

/**
 * The gap-behavior contract Family 1 requires: `NOT_ADMITTED` is a
 * first-class, honest disposition - never a thrown error, never treated as
 * equivalent to `RESOLVED` - for the ordinary case where a service is
 * declared-resolvable (per `commercial-order.ts`) but has no matching,
 * currently-`ADMITTED` `ServiceCatalogAdmission` covering that exact
 * blueprintId/blueprintVersion/recipeId triple. A stale admission bound to
 * a since-superseded blueprint version, or a `REVOKED` one, never silently
 * satisfies a newer/different resolution.
 */
export type TrustedServiceResolution =
  | {
      readonly status: "RESOLVED";
      readonly admission: ServiceCatalogAdmission;
    }
  | {
      readonly status: "NOT_ADMITTED";
      readonly serviceRef: string;
      readonly reason: string;
    }
  | {
      readonly status: "UNRESOLVED_SERVICE";
      readonly reason: string;
    };

/**
 * Composes `commercial-order.ts`'s `resolveDeclaredServiceFromOrder` output
 * (never re-implemented here) with the admission boundary above. `order` is
 * accepted only to keep the caller's intent explicit and symmetric with
 * `resolveDeclaredServiceFromOrder`'s own signature; the declared lookup
 * result already carries every field this function actually consults.
 */
export function resolveTrustedServiceForOrder(input: {
  order: CommercialOrder;
  declaredLookup: DeclaredServiceLookupResult;
  admittedCatalog: ReadonlyArray<ServiceCatalogAdmission>;
}): TrustedServiceResolution {
  if (input.declaredLookup.status === "UNRESOLVED_SERVICE") {
    return {
      status: "UNRESOLVED_SERVICE",
      reason: input.declaredLookup.reason,
    };
  }
  const declared = input.declaredLookup;
  const matches = input.admittedCatalog.filter(
    (admission) =>
      admission.status === "ADMITTED" &&
      admission.serviceRef === input.order.serviceRef &&
      admission.blueprintId === declared.blueprintId &&
      admission.blueprintVersion === declared.blueprintVersion &&
      admission.recipeId === declared.recipeId,
  );
  if (matches.length > 1) {
    throw new InvalidServiceCatalogAdmissionError(
      `admittedCatalog declares more than one ADMITTED entry for serviceRef "${input.order.serviceRef}" at blueprint "${declared.blueprintId}" v${declared.blueprintVersion} (ambiguous admission)`,
    );
  }
  const admission = matches[0];
  if (admission === undefined) {
    return {
      status: "NOT_ADMITTED",
      serviceRef: input.order.serviceRef,
      reason: `no currently-ADMITTED ServiceCatalogAdmission covers serviceRef "${input.order.serviceRef}" at blueprint "${declared.blueprintId}" v${declared.blueprintVersion} / recipe "${declared.recipeId}"`,
    };
  }
  return { status: "RESOLVED", admission };
}
