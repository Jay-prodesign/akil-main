import type { CommercialOrder, ServiceCatalogEntry, DeclaredServiceLookupResult } from "./commercial-order.js";
import type { OfferBlueprintVersion } from "./offer-blueprint.js";
import type { DeliveryRecipe } from "./delivery-recipe.js";
import type { AdmittedWorker } from "./worker-routing-policy.js";

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
 * Rev102 F1 correction: `admittedAt`/`revokedAt` were previously validated
 * only as non-empty strings, and revocation ordering was checked with
 * lexicographic string comparison - a malformed timestamp, or two
 * equivalent instants expressed with different timezone offsets, could
 * therefore be accepted or misordered. Mirrors `partner-capability-
 * admission.ts`'s own Rev62 fix exactly: both fields must parse as a real
 * instant, and every ordering comparison below uses the parsed `ms` value,
 * never the raw string.
 */
function requireValidTimestamp(value: unknown, field: string): { raw: string; ms: number } {
  const raw = requireNonEmptyString(value, field);
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new InvalidServiceCatalogAdmissionError(`${field} must be a valid ISO timestamp`);
  }
  return { raw, ms };
}

/**
 * Rev102 F2 correction: this function previously accepted a bare, caller-
 * supplied `admittedByAuthorityId` string with no admission/authority
 * binding at all - it recorded a provenance *label*, never an actual
 * admitted-authority decision, even though Family 1 explicitly requires a
 * trusted/admitted service-catalog provenance/authority boundary. Rather
 * than invent a second IAM/global-authority model (`ServiceCatalogEntry`
 * itself has no tenant scope, so `authority.ts`'s tenant-bound
 * `AuthorityContext` would misrepresent this as a tenant-scoped action),
 * this reuses `worker-routing-policy.ts`'s existing, already-established,
 * non-tenant-scoped admitted-identity/authority-level primitive
 * (`AdmittedWorker`) exactly as `resolveWorkerRoute` itself already gates
 * protected/high-trust-scope routes on `authorityLevel: "ELEVATED"`. An
 * `authorizingWorker` that is not `trustStatus: "ADMITTED"` or not
 * `authorityLevel: "ELEVATED"` can never admit a catalog entry - an
 * unproven/untrusted/standard-authority caller label can no longer
 * silently become trusted catalog authority.
 */
export function admitServiceCatalogEntry(input: {
  catalogEntry: ServiceCatalogEntry;
  recipe: DeliveryRecipe;
  authorizingWorker: AdmittedWorker;
  evidenceRef: unknown;
  admittedAt: unknown;
}): ServiceCatalogAdmission {
  if (input.catalogEntry.recipeId !== input.recipe.recipeId) {
    throw new InvalidServiceCatalogAdmissionError(
      `catalogEntry.recipeId "${input.catalogEntry.recipeId}" does not match recipe.recipeId "${input.recipe.recipeId}"`,
    );
  }
  if (input.authorizingWorker.trustStatus !== "ADMITTED") {
    throw new InvalidServiceCatalogAdmissionError(
      `authorizingWorker must have trustStatus "ADMITTED" (got "${input.authorizingWorker.trustStatus}") - an unproven/untrusted caller cannot admit a service catalog entry`,
    );
  }
  if (input.authorizingWorker.authorityLevel !== "ELEVATED") {
    throw new InvalidServiceCatalogAdmissionError(
      `authorizingWorker must have authorityLevel "ELEVATED" (got "${input.authorizingWorker.authorityLevel}") - only elevated-authority workers may admit a trusted service catalog entry`,
    );
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  const admittedAt = requireValidTimestamp(input.admittedAt, "admittedAt");
  return {
    serviceRef: input.catalogEntry.serviceRef,
    blueprintId: input.catalogEntry.blueprintId,
    blueprintVersion: input.catalogEntry.blueprintVersion,
    recipeId: input.catalogEntry.recipeId,
    status: "ADMITTED",
    admittedByAuthorityId: input.authorizingWorker.workerId,
    evidenceRef,
    admittedAt: admittedAt.raw,
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
  const revokedAt = requireValidTimestamp(input.revokedAt, "revokedAt");
  const admittedAt = requireValidTimestamp(input.admission.admittedAt, "admission.admittedAt");
  const reason = requireNonEmptyString(input.reason, "reason");
  if (revokedAt.ms < admittedAt.ms) {
    throw new InvalidServiceCatalogAdmissionTransitionError(
      "revokedAt must not be before admittedAt",
    );
  }
  return {
    ...input.admission,
    status: "REVOKED",
    revokedAt: revokedAt.raw,
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
