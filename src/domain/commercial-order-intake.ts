import type { TenantScope } from "./tenant-scope.js";
import type { Project } from "./project.js";
import type { OfferBlueprintVersion } from "./offer-blueprint.js";
import { createSoldScope, type SoldScope } from "./sold-scope.js";
import type { TrustedServiceResolution } from "./service-catalog-admission.js";

export class InvalidCommercialOrderIntakeError extends Error {
  constructor(reason: string) {
    super(`Invalid commercial order intake: ${reason}`);
    this.name = "InvalidCommercialOrderIntakeError";
  }
}

/**
 * Rev62 AUD-V5-GAP-02 "Conditional Intake" - the Cold-Start audit found
 * this exact gap: "sold-scope/evidence/blueprint primitives exist but no
 * order-driven intake compiler." Nothing previously bound a resolved
 * `CommercialOrder` to the `SoldScope` built from it - a caller could
 * construct a `SoldScope` against any blueprint regardless of what the
 * order actually resolved to. This function is that missing binding.
 *
 * C8 (whole-product gap scan; AUD-V5-GAP-02 "trusted service-resolution
 * provenance ... explicitly OPEN"; the follow-up composition SVC-ADM-001
 * names): this boundary previously accepted the raw, caller-self-declared
 * `DeclaredServiceLookupResult` (`resolveDeclaredServiceFromOrder`,
 * `commercial-order.ts`), which proves only that the caller's own supplied
 * catalog declares one matching entry - a sold scope could therefore be
 * intaken for a service that was merely declared-resolvable, with no
 * `ServiceCatalogAdmission` backing it at all. It now requires the
 * admission-catalog-checked `TrustedServiceResolution` produced by
 * `resolveTrustedServiceForOrder` (`service-catalog-admission.ts`): only a
 * `RESOLVED` variant - which by construction carries the one matching,
 * currently-`ADMITTED` `ServiceCatalogAdmission` - may be intaken.
 * `NOT_ADMITTED` (declared-resolvable, no backing admission) and
 * `UNRESOLVED_SERVICE` both fail closed.
 *
 * The supplied `blueprint`'s identity/version must then exactly match the
 * admission's own `blueprintId`/`blueprintVersion` (same "exact-version
 * validation" discipline already established by the Rev62 batch1
 * blueprint-binding correction), after which this delegates entirely to
 * the already-verified `createSoldScope` - no sold-scope
 * construction/validation logic is duplicated here.
 */
export function intakeSoldScopeFromResolution(input: {
  tenantScope: TenantScope;
  project: Project;
  resolution: TrustedServiceResolution;
  blueprint: OfferBlueprintVersion;
  soldScopeId: unknown;
  outcomeContractRef: unknown;
  includedRequirementIds?: unknown;
  excludedRequirementIds?: unknown;
}): SoldScope {
  if (input.resolution.status !== "RESOLVED") {
    throw new InvalidCommercialOrderIntakeError(
      `cannot intake a commercial order whose service resolution is not a trust-admitted RESOLVED TrustedServiceResolution (got "${input.resolution.status}") - a declared-resolvable service with no currently-ADMITTED ServiceCatalogAdmission backing it is never intake-eligible`,
    );
  }
  const { admission } = input.resolution;
  if (input.blueprint.blueprintId !== admission.blueprintId) {
    throw new InvalidCommercialOrderIntakeError(
      `blueprint "${input.blueprint.blueprintId}" does not match the admitted service resolution's blueprintId "${admission.blueprintId}"`,
    );
  }
  if (input.blueprint.version !== admission.blueprintVersion) {
    throw new InvalidCommercialOrderIntakeError(
      `blueprint version "${input.blueprint.version}" does not match the admitted service resolution's blueprintVersion "${admission.blueprintVersion}"`,
    );
  }
  return createSoldScope({
    tenantScope: input.tenantScope,
    project: input.project,
    soldScopeId: input.soldScopeId,
    outcomeContractRef: input.outcomeContractRef,
    includedRequirementIds: input.includedRequirementIds,
    excludedRequirementIds: input.excludedRequirementIds,
  });
}
