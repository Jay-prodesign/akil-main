import type { ProjectOwnershipRef } from "./project-ownership.js";
import type {
  ClientProjectSnapshot,
  CustomerSafeCapabilitySummary,
  NextAction,
  EtaProjection,
  WorkingArtifactState,
} from "./client-project-snapshot.js";
import type { DeliveryStatusLabel } from "./delivery-status.js";
import type { DeliveryRecipePlanBinding } from "./delivery-recipe-plan-binding.js";
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
    readonly recipeId: DeliveryRecipePlanBinding["boundRecipeId"];
    readonly version: DeliveryRecipePlanBinding["consumedRecipeVersion"];
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
  readonly recipeId?: DeliveryRecipePlanBinding["boundRecipeId"];
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
 * Brain PR #66 F5 correction (Rev26): applicability previously accepted
 * `binding.boundJobs` at face value - a single matching `specId` was
 * sufficient, even if the array itself was structurally incoherent (empty,
 * duplicate `specId`s, or entries whose `specId`/`requirementId` were
 * hand-assembled rather than genuinely produced by AI-004A's
 * `bindAdmittedRecipeToPlan`). `deriveOutcomeJobSpecs` always sets
 * `jobFamily` to the exact same value as `requirementId` (see
 * `outcome-job-spec.ts`), and `wireAdmittedOutcomeJobs` carries that
 * `jobFamily` verbatim onto the runtime `OutcomeJob` - so a genuine
 * `boundJobs` entry's `requirementId` must equal the matched job's own
 * `jobFamily`, not merely its `specId` matching `jobId`. This function
 * requires the whole `boundJobs` array to be non-empty with unique,
 * non-empty `specId`s before ever consulting it, then requires the
 * matched entry itself to satisfy both identity facts together.
 */
function boundJobsAreStructurallyCoherent(
  boundJobs: DeliveryRecipePlanBinding["boundJobs"],
): boolean {
  if (boundJobs.length === 0) {
    return false;
  }
  const seenSpecIds = new Set<string>();
  for (const boundJob of boundJobs) {
    const specId = boundJob.specId as string;
    const requirementId = boundJob.requirementId as string;
    if (specId.length === 0 || requirementId.length === 0) {
      return false;
    }
    if (seenSpecIds.has(specId)) {
      return false;
    }
    seenSpecIds.add(specId);
  }
  return true;
}

/**
 * AA-005 Rev29 correction: `boundJobsAreStructurallyCoherent` above only
 * proves the array's own internal shape (non-empty, unique/non-empty
 * specIds) - it says nothing about whether every entry in that array is
 * genuinely represented in this project's real jobs. Combined with the
 * "at least one job matches at least one boundJob" check that used to gate
 * applicability, a cloned binding could retain every genuine entry and
 * still append one unique, well-formed but entirely foreign/injected
 * `boundJobs` entry (an identity no real `OutcomeJob` in the snapshot ever
 * carries) - the coherence check would accept it (nothing duplicated or
 * empty) and the old existential match would still succeed on a retained
 * genuine entry, silently laundering the injected entry's presence through
 * an otherwise-valid binding. This function instead requires the WHOLE
 * `boundJobs` array to be exactly represented in the snapshot's real job
 * set - every single entry, not just one - so one foreign entry anywhere in
 * the array is enough to deny provenance outright.
 */
function boundJobsAreFullyRepresentedInSnapshot(
  boundJobs: DeliveryRecipePlanBinding["boundJobs"],
  jobs: ClientProjectSnapshot["deliveryStatus"]["jobs"],
): boolean {
  return boundJobs.every((boundJob) =>
    jobs.some(
      (job) =>
        (boundJob.specId as string) === (job.jobId as string) &&
        (boundJob.requirementId as string) === job.jobFamily,
    ),
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
 *
 * CXP-001A: recipe provenance is proven only through a verified AI-004A
 * `DeliveryRecipePlanBinding` - never a raw caller-supplied `DeliveryRecipe`
 * alone and never a `jobFamily` string comparison. The prior check compared
 * a recipe's blueprint-level `jobFamily` (e.g. `"website-build-v1"`)
 * against a real wired `OutcomeJob`'s requirement-level `jobFamily` (e.g.
 * `"design-build"`, `"handover"` - see `outcome-job-spec.ts`/
 * `outcome-job-wiring.ts`), which can never legitimately be equal on a
 * genuine cold-start lineage and could only ever "match" by an unbound
 * caller-supplied recipe coincidentally sharing a fixture string. This
 * function instead requires the binding's own tenant/project to match
 * `ownership`, the binding's plan to match the snapshot's
 * `workingArtifact` when one is present, and every entry of the binding's
 * own `boundJobs` array to be a job the snapshot's real jobs actually
 * contain (`boundJobs[].specId === job.jobId`, the same deterministic
 * identity `outcome-job-routing-execution.ts` already relies on) - not
 * merely at least one of them (AA-005 Rev29; see
 * `boundJobsAreFullyRepresentedInSnapshot` above).
 *
 * Brain PR #66 F5 correction: a `binding` alone is not sufficient - the
 * caller must also supply the concrete `recipe` the binding claims to have
 * consumed, and its `recipeId`/`version` must exactly equal
 * `binding.boundRecipeId`/`binding.consumedRecipeVersion`. A `recipe`
 * supplied without a matching `binding` (or vice versa) still yields no
 * provenance - `recipeId`/`version` on the observation are exposed only
 * from the binding's own already-verified fields once both checks pass,
 * never trusted from the raw `recipe` object directly.
 *
 * AA-005 Rev29 correction: the applicability check used to require only
 * that SOME snapshot job matched SOME `boundJobs` entry - so a cloned
 * binding retaining every genuine entry could still smuggle in one unique,
 * well-formed but entirely foreign `boundJobs` entry (an identity no real
 * job in the snapshot carries) and still be cited as applicable provenance,
 * since a genuine entry elsewhere in the array would satisfy the
 * existential match. Provenance now requires the WHOLE `boundJobs` array to
 * be exactly represented in the snapshot's real jobs - one foreign/injected
 * entry anywhere in the array is enough to deny applicability outright.
 */
export function buildAdvisorResult(input: {
  ownership: ProjectOwnershipRef;
  snapshot: ClientProjectSnapshot;
  recipe?: DeliveryRecipe;
  binding?: DeliveryRecipePlanBinding;
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

  const binding = input.binding;
  const recipe = input.recipe;
  const workingArtifact = input.snapshot.workingArtifact;
  let applicableRecipeRef: AdvisorObservation["applicableRecipeRef"];
  if (
    binding !== undefined &&
    recipe !== undefined &&
    recipe.recipeId === binding.boundRecipeId &&
    recipe.version === binding.consumedRecipeVersion &&
    binding.tenantId === input.ownership.tenantId &&
    binding.projectId === input.ownership.projectId &&
    (input.ownership.serviceRef === undefined || input.ownership.serviceRef === binding.serviceRef) &&
    (workingArtifact === undefined ||
      (workingArtifact.planId === binding.planId && workingArtifact.currentVersion === binding.planVersion)) &&
    boundJobsAreStructurallyCoherent(binding.boundJobs) &&
    boundJobsAreFullyRepresentedInSnapshot(binding.boundJobs, input.snapshot.deliveryStatus.jobs)
  ) {
    applicableRecipeRef = { recipeId: binding.boundRecipeId, version: binding.consumedRecipeVersion };
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
