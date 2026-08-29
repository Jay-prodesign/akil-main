import { WEBSITE_BUILD_V1_OWNERSHIP } from "./website-build-v1-communication.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  type ConnectionRequirement,
  type ConnectionBinding,
} from "../domain/connection-authority.js";
import { createCapabilityAdmission, type CapabilityAdmission } from "../domain/capability-admission.js";

/**
 * V2-CDO-004 "one minimal fixture/example using the existing V2-CDO-003
 * customer/organization/project ownership lineage and an existing
 * service/job/capability context" (IN SCOPE #8). Reuses
 * `WEBSITE_BUILD_V1_OWNERSHIP` (V2-CDO-003) directly rather than
 * inventing a parallel ownership identity, and `"required-access-
 * connections"` - the existing `WEBSITE_BUILD_v1` blueprint requirement
 * (`src/fixtures/website-build-v1.ts`, DEL-003) already described as
 * "Declare required external access/connections as versioned
 * ConnectionRequirement references (no raw credentials)" - as the
 * `requiredCapabilityRef`, with `requiredByRef` pointing at the existing
 * downstream requirement that actually depends on it,
 * `"optional-ecommerce-integration"`. Provider-neutral: `connectionMethod`
 * and `minimumProviderScope`/`delegatedScope` are generic reference
 * strings, not any real commerce/provider SDK identity (C11).
 */
export const WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT: ConnectionRequirement =
  createConnectionRequirement({
    connectionRequirementId: "conn-req-website-build-v1-storefront",
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    requiredCapabilityRef: "required-access-connections",
    purpose: "Read-only storefront catalog access needed to complete the optional e-commerce integration slice",
    requiredByRef: "optional-ecommerce-integration",
    accountOwner: "CUSTOMER_OWNED",
    minimumProviderScope: ["catalog:read"],
    connectionMethod: "OAUTH",
    validationRequirement: "provider-reported connection health check",
  });

/**
 * Constructed at `REQUESTED` (no external effect), then advanced through
 * `CONNECTED_UNVERIFIED` and finally `VERIFIED` via `verifyConnectionBinding`
 * with an explicit evidence reference - illustrating that neither
 * construction nor a bare state transition alone can promote verification
 * (C6).
 */
export const WEBSITE_BUILD_V1_CONNECTION_BINDING: ConnectionBinding = (() => {
  const requested = createConnectionBinding({
    connectionBindingId: "conn-binding-website-build-v1-storefront",
    requirement: WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT,
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
    providerRef: "reference-storefront-provider",
    workspaceRef: "reference-storefront-workspace",
    integrationInstanceRef: "reference-storefront-instance-1",
    delegatedScope: ["catalog:read"],
  });
  const connectedUnverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectionBinding(
    connectedUnverified,
    "internal://reference-fixtures/website-build-v1/connection-health-check",
  );
})();

/**
 * `VERIFIED_AVAILABLE` only because the binding above is already
 * `VERIFIED` and carries a matching ownership tuple + explicit evidence
 * reference (C8).
 */
export const WEBSITE_BUILD_V1_CAPABILITY_ADMISSION: CapabilityAdmission = createCapabilityAdmission({
  capabilityAdmissionId: "cap-admission-website-build-v1-storefront",
  ownership: WEBSITE_BUILD_V1_OWNERSHIP,
  requiredCapabilityRef: "required-access-connections",
  status: "VERIFIED_AVAILABLE",
  binding: WEBSITE_BUILD_V1_CONNECTION_BINDING,
  requirement: WEBSITE_BUILD_V1_CONNECTION_REQUIREMENT,
  evidenceRef: "internal://reference-fixtures/website-build-v1/capability-admission-evidence",
});
