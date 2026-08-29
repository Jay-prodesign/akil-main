import { buildAdvisorResult, type AdvisorResult } from "../domain/delivery-advisor.js";
import { WEBSITE_BUILD_V1_OWNERSHIP } from "./website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT } from "./website-build-v1-snapshot.js";
import { WEBSITE_BUILD_V1_RECIPE } from "./website-build-v1-recipe.js";

/**
 * V2-CDO-008 "one canonical WEBSITE_BUILD_v1 fixture" reference proof.
 * Reuses the existing V2-CDO-005 snapshot fixture and V2-CDO-002 recipe
 * fixture verbatim - this module introduces no new project/job/capability
 * state. The underlying snapshot job (`jobFamily: "website-build-v1"`)
 * matches `WEBSITE_BUILD_V1_RECIPE.jobFamily`, so `applicableRecipeRef` is
 * populated, and the snapshot's one `VERIFIED_AVAILABLE` capability
 * produces exactly one `L1_RECOMMEND` recommendation - exercising both the
 * observe and recommend paths against real, already-verified fixture data
 * rather than a synthetic example.
 */
export const WEBSITE_BUILD_V1_ADVISOR_RESULT: AdvisorResult = buildAdvisorResult({
  ownership: WEBSITE_BUILD_V1_OWNERSHIP,
  snapshot: WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT,
  recipe: WEBSITE_BUILD_V1_RECIPE,
});
