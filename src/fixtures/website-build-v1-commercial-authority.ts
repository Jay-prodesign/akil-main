import { WEBSITE_BUILD_V1_OWNERSHIP } from "./website-build-v1-communication.js";
import {
  buildCommercialAuthoritySnapshot,
  type CommercialAuthoritySnapshot,
} from "../domain/commercial-authority.js";

/**
 * Canonical WEBSITE_BUILD_v1 commercial-authority read-model fixture,
 * reusing the existing `WEBSITE_BUILD_V1_OWNERSHIP` tuple verbatim (no
 * parallel ownership identity created for this slice).
 */
export const WEBSITE_BUILD_V1_COMMERCIAL_AUTHORITY_SNAPSHOT: CommercialAuthoritySnapshot =
  buildCommercialAuthoritySnapshot({
    ownership: WEBSITE_BUILD_V1_OWNERSHIP,
  });
