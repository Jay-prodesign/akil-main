import type { TenantScope } from "./tenant-scope.js";
import type { Project } from "./project.js";
import type { OfferBlueprintVersion } from "./offer-blueprint.js";
import { createSoldScope, type SoldScope } from "./sold-scope.js";
import type { CanonicalServiceResolution } from "./commercial-order.js";

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
 * order actually resolved to (`resolveCanonicalServiceFromOrder`,
 * `commercial-order.ts`). This function is that missing binding: it fails
 * closed unless the supplied `blueprint`'s identity/version exactly
 * matches the order's own resolution (same "exact-version validation"
 * discipline already established by the Rev62 batch1 blueprint-binding
 * correction), then delegates entirely to the already-verified
 * `createSoldScope` - no sold-scope construction/validation logic is
 * duplicated here.
 */
export function intakeSoldScopeFromResolution(input: {
  tenantScope: TenantScope;
  project: Project;
  resolution: CanonicalServiceResolution;
  blueprint: OfferBlueprintVersion;
  soldScopeId: unknown;
  outcomeContractRef: unknown;
  includedRequirementIds?: unknown;
  excludedRequirementIds?: unknown;
}): SoldScope {
  if (input.resolution.status !== "RESOLVED") {
    throw new InvalidCommercialOrderIntakeError(
      "cannot intake a commercial order whose service resolution is not RESOLVED",
    );
  }
  if (input.blueprint.blueprintId !== input.resolution.blueprintId) {
    throw new InvalidCommercialOrderIntakeError(
      `blueprint "${input.blueprint.blueprintId}" does not match the order's resolved blueprintId "${input.resolution.blueprintId}"`,
    );
  }
  if (input.blueprint.version !== input.resolution.blueprintVersion) {
    throw new InvalidCommercialOrderIntakeError(
      `blueprint version "${input.blueprint.version}" does not match the order's resolved blueprintVersion "${input.resolution.blueprintVersion}"`,
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
