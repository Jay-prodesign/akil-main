import { WEBSITE_BUILD_V1_OWNERSHIP } from "./website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_CAPABILITY_ADMISSION } from "./website-build-v1-connection.js";
import {
  resolveServiceCapabilityRoute,
  type ServiceCapabilityRoute,
} from "../domain/service-capability-routing.js";

/**
 * Canonical WEBSITE_BUILD_v1 service-capability route fixture, reusing
 * the existing `WEBSITE_BUILD_V1_OWNERSHIP` and
 * `WEBSITE_BUILD_V1_CAPABILITY_ADMISSION` (V2-CDO-004) fixtures verbatim
 * - no parallel ownership or capability-admission identity created for
 * this slice.
 */
export const WEBSITE_BUILD_V1_SERVICE_ROUTE: ServiceCapabilityRoute = resolveServiceCapabilityRoute({
  ownership: WEBSITE_BUILD_V1_OWNERSHIP,
  serviceFamilyRef: "website-build-v1",
  admission: WEBSITE_BUILD_V1_CAPABILITY_ADMISSION,
});
