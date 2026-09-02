import { WEBSITE_BUILD_V1_OWNERSHIP } from "./website-build-v1-communication.js";
import {
  WEBSITE_BUILD_V1_CAPABILITY_ADMISSION,
  WEBSITE_BUILD_V1_CONNECTION_BINDING,
} from "./website-build-v1-connection.js";
import {
  resolveServiceCapabilityRoute,
  type ServiceCapabilityRoute,
} from "../domain/service-capability-routing.js";

/**
 * Canonical WEBSITE_BUILD_v1 service-capability route fixture, reusing
 * the existing `WEBSITE_BUILD_V1_OWNERSHIP`, `WEBSITE_BUILD_V1_CAPABILITY_ADMISSION`,
 * and `WEBSITE_BUILD_V1_CONNECTION_BINDING` (V2-CDO-004) fixtures verbatim
 * - no parallel ownership, capability-admission, or connection-binding
 * identity created for this slice. The binding is supplied explicitly
 * (Rev28 bounded correction) so this reference route proves current
 * provider connectivity rather than trusting the admission snapshot alone.
 */
export const WEBSITE_BUILD_V1_SERVICE_ROUTE: ServiceCapabilityRoute = resolveServiceCapabilityRoute({
  ownership: WEBSITE_BUILD_V1_OWNERSHIP,
  serviceFamilyRef: "website-build-v1",
  admission: WEBSITE_BUILD_V1_CAPABILITY_ADMISSION,
  connectionBinding: WEBSITE_BUILD_V1_CONNECTION_BINDING,
});
