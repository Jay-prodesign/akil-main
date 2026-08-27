import type { ProjectOwnershipRef } from "./project-ownership.js";
import type {
  ClientProjectSnapshot,
  CustomerSafeCapabilitySummary,
  NextAction,
  EtaProjection,
  WorkingArtifactState,
} from "./client-project-snapshot.js";
import type { DeliveryStatusLabel } from "./delivery-status.js";
import type { DeliveryRecipe } from "./delivery-recipe.js";

export class InvalidAdvisorContextError extends Error {
  constructor(reason: string) {
    super(`Invalid AdvisorContext: ${reason}`);
    this.name = "InvalidAdvisorContextError";
  }
}

/**
 * V2-CDO-008 authority ceiling: L0 Observe / L1 Recommend only. No L2
 * Prepare, L3 Approved Execute, L4 autonomous or L5 developer-assisted
 * execution level exists in this module's type space at all.
 */
export type AdvisorMaturityLevel = "L0_OBSERVE" | "L1_RECOMMEND";

export type AdvisorResultStatus = "RECOMMENDATIONS_AVAILABLE" | "UNAVAILABLE";

/**
 * L0 Observe (A4): every field here is copied or filtered straight from
 * the given `ClientProjectSnapshot` - this type defines no business rule
 * capable of upgrading `eta`/`nextAction` beyond what the snapshot itself
 * already asserts, so `EtaProjection`'s `UNKNOWN` status (the only variant
 * that exists today) always passes through unchanged.
 */
export interface AdvisorObservation {
  readonly overallStatus: DeliveryStatusLabel;
  readonly nextAction: NextAction;
  readonly eta: EtaProjection;
  readonly verifiedCompletedJobCount: number;
  readonly workingArtifact?: WorkingArtifactState;
  readonly unsupportedCapabilityRefs: ReadonlyArray<
    CustomerSafeCapabilitySummary["requiredCapabilityRef"]
  >;
  readonly ineligibleCapabilityRefs: ReadonlyArray<
    CustomerSafeCapabilitySummary["requiredCapabilityRef"]
  >;
  readonly applicableRecipeRef?: {
    readonly recipeId: DeliveryRecipe["recipeId"];
    readonly version: DeliveryRecipe["version"];
  };
}

/**
 * L1 Recommend (A5): an `AdvisorRecommendationOption` can only be
 * constructed from a capability summary whose `status` is exactly
 * `VERIFIED_AVAILABLE` - `buildAdvisorResult` below has no code path that
 * reads `UNVERIFIED`/`UNSUPPORTED`/`INELIGIBLE` into `recommendations`.
 * `basedOnCapabilityRef`/`recipeId` are provenance references only (A11) -
 * no execution/mutation/approval field exists on this type.
 */
export interface AdvisorRecommendationOption {
  readonly optionId: string;
  readonly basedOnCapabilityRef: CustomerSafeCapabilitySummary["requiredCapabilityRef"];
  readonly recipeId?: DeliveryRecipe["recipeId"];
  readonly description: string;
}

export interface AdvisorResult {
  readonly ownership: ProjectOwnershipRef;
  readonly maturity: AdvisorMaturityLevel;
  readonly observation: AdvisorObservation;
  readonly status: AdvisorResultStatus;
  readonly recommendations: ReadonlyArray<AdvisorRecommendationOption>;
  readonly unavailableReason?: string;
}

function ownershipEquals(a: ProjectOwnershipRef, b: ProjectOwnershipRef): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.projectId === b.projectId &&
    a.serviceRef === b.serviceRef
  );
}

/**
 * V2-CDO-008 minimum Delivery Project Advisor (L0 Observe / L1 Recommend).
 * Pure, deterministic, provider-neutral: no model/provider SDK, prompt,
 * persistent memory, RAG/vector store or command/mutation surface exists
 * anywhere in this module. `buildAdvisorResult` is the only export capable
 * of producing an `AdvisorResult`, and it only ever reads its inputs - it
 * imports no create/transition/verify function from `client-project-
 * snapshot.ts`, `delivery-recipe.ts`, `outcome-job.ts`,
 * `project-plan.ts`, `approval-reference.ts`, `capability-admission.ts` or
 * `connection-authority.ts` (types only), so it structurally cannot
 * transition an `OutcomeJob`, approve a plan, or promote a capability
 * (A7).
 *
 * A3: `ownership` must exactly match `snapshot.ownership` - a caller
 * substituting a foreign tenant/customer/project/service tuple is
 * contamination, rejected before any observation/recommendation is
 * constructed, matching the fail-closed pattern already established by
 * `buildClientProjectSnapshot` (V2-CDO-005) and
 * `createCapabilityAdmission` (V2-CDO-004).
 */
export function buildAdvisorResult(input: {
  ownership: ProjectOwnershipRef;
  snapshot: ClientProjectSnapshot;
  recipe?: DeliveryRecipe;
}): AdvisorResult {
  if (!ownershipEquals(input.ownership, input.snapshot.ownership)) {
    throw new InvalidAdvisorContextError(
      "ownership does not match the given snapshot's ownership tuple",
    );
  }

  const eligible = input.snapshot.capabilities.filter(
    (capability) => capability.status === "VERIFIED_AVAILABLE",
  );
  const unsupportedCapabilityRefs = input.snapshot.capabilities
    .filter((capability) => capability.status === "UNSUPPORTED")
    .map((capability) => capability.requiredCapabilityRef);
  const ineligibleCapabilityRefs = input.snapshot.capabilities
    .filter(
      (capability) =>
        capability.status === "INELIGIBLE" || capability.status === "UNVERIFIED",
    )
    .map((capability) => capability.requiredCapabilityRef);

  // A1/A11: a recipe is only cited as "applicable" provenance when its own
  // jobFamily actually appears among this project's real OutcomeJob
  // records - never merely because a caller happened to pass one in.
  let applicableRecipeRef: AdvisorObservation["applicableRecipeRef"];
  if (
    input.recipe !== undefined &&
    input.snapshot.deliveryStatus.jobs.some(
      (job) => job.jobFamily === input.recipe!.jobFamily,
    )
  ) {
    applicableRecipeRef = { recipeId: input.recipe.recipeId, version: input.recipe.version };
  }

  const observation: AdvisorObservation = {
    overallStatus: input.snapshot.deliveryStatus.overallStatus,
    nextAction: input.snapshot.nextAction,
    eta: input.snapshot.eta,
    verifiedCompletedJobCount: input.snapshot.verifiedCompletedJobIds.length,
    ...(input.snapshot.workingArtifact !== undefined
      ? { workingArtifact: input.snapshot.workingArtifact }
      : {}),
    unsupportedCapabilityRefs,
    ineligibleCapabilityRefs,
    ...(applicableRecipeRef !== undefined ? { applicableRecipeRef } : {}),
  };

  if (eligible.length === 0) {
    return {
      ownership: input.ownership,
      maturity: "L0_OBSERVE",
      observation,
      status: "UNAVAILABLE",
      recommendations: [],
      unavailableReason:
        "No policy-eligible (VERIFIED_AVAILABLE) capability exists for this project yet.",
    };
  }

  const recommendations: AdvisorRecommendationOption[] = eligible.map((capability) => ({
    optionId: `advisor-option-${capability.requiredCapabilityRef}`,
    basedOnCapabilityRef: capability.requiredCapabilityRef,
    ...(applicableRecipeRef !== undefined ? { recipeId: applicableRecipeRef.recipeId } : {}),
    description: `Continue delivery using the verified, admitted "${capability.requiredCapabilityRef}" capability.`,
  }));

  return {
    ownership: input.ownership,
    maturity: "L1_RECOMMEND",
    observation,
    status: "RECOMMENDATIONS_AVAILABLE",
    recommendations,
  };
}
