import { buildAdvisorResult, type AdvisorResult } from "../domain/delivery-advisor.js";
import {
  WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
  WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING,
  WEBSITE_BUILD_V1_BOUND_CLIENT_PROJECT_SNAPSHOT,
} from "./website-build-v1-recipe-binding.js";

/**
 * CXP-001A "one canonical WEBSITE_BUILD_v1 fixture" reference proof.
 * Reuses the genuine cold-start-derived binding/snapshot fixture
 * (`website-build-v1-recipe-binding.ts`) rather than the older, broken
 * jobFamily-string-coincidence composition - `applicableRecipeRef` is now
 * populated because the verified AI-004A `DeliveryRecipePlanBinding`
 * actually proves this project's real jobs were wired from the admitted
 * recipe's own derived spec set (`binding.boundJobs[].specId ===
 * job.jobId`), not because a caller-supplied recipe's blueprint-level
 * `jobFamily` happened to match a hand-picked fixture string. The
 * snapshot's one `VERIFIED_AVAILABLE` capability produces exactly one
 * `L1_RECOMMEND` recommendation.
 */
export const WEBSITE_BUILD_V1_ADVISOR_RESULT: AdvisorResult = buildAdvisorResult({
  ownership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
  snapshot: WEBSITE_BUILD_V1_BOUND_CLIENT_PROJECT_SNAPSHOT,
  binding: WEBSITE_BUILD_V1_RECIPE_PLAN_BINDING,
});
