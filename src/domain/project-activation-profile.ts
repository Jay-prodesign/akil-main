import { createHash } from "node:crypto";
import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { OfferBlueprintVersion } from "./offer-blueprint.js";
import type { SoldScope } from "./sold-scope.js";
import type { CustomerEvidenceItem } from "./customer-evidence.js";
import type { DeliveryRecipe } from "./delivery-recipe.js";
import { compilePlan, type ProjectPlanVersion } from "./project-plan.js";
import {
  admitPlan,
  admitJobs,
  type PlanAdmissionResult,
  type JobAdmissionResult,
} from "./plan-admission.js";
import { deriveOutcomeJobSpecs, type OutcomeJobSpec } from "./outcome-job-spec.js";
import { wireAdmittedOutcomeJobs } from "./outcome-job-wiring.js";
import type { OutcomeJob } from "./outcome-job.js";
import type { EvidenceReadinessAssertion } from "./admission-readiness.js";
import type { ApprovalReference } from "./approval-reference.js";
import type { ConnectionRequirement, ConnectionBinding } from "./connection-authority.js";
import {
  resolveWorkerRoute,
  type WorkerRoutingRequest,
  type WorkerRoutingDecision,
} from "./worker-routing-policy.js";

export class InvalidAcceptedCommercialReferenceError extends Error {
  constructor(reason: string) {
    super(`Invalid AcceptedCommercialReference: ${reason}`);
    this.name = "InvalidAcceptedCommercialReferenceError";
  }
}

export class InvalidMaterialPlatformDecisionError extends Error {
  constructor(reason: string) {
    super(`Invalid MaterialPlatformDecision: ${reason}`);
    this.name = "InvalidMaterialPlatformDecisionError";
  }
}

export class InvalidProjectActivationProfileError extends Error {
  constructor(reason: string) {
    super(`Invalid ProjectActivationProfile input: ${reason}`);
    this.name = "InvalidProjectActivationProfileError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidProjectActivationProfileError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidProjectActivationProfileError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidProjectActivationProfileError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidProjectActivationProfileError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function requireOpaqueStringArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new InvalidProjectActivationProfileError(`${field} must be an array`);
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${field}[${index}]`));
}

function requireNonEmptyPlatformDecisionString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidMaterialPlatformDecisionError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidMaterialPlatformDecisionError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidMaterialPlatformDecisionError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidMaterialPlatformDecisionError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function requireNonEmptyCommercialReferenceString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidAcceptedCommercialReferenceError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidAcceptedCommercialReferenceError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidAcceptedCommercialReferenceError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidAcceptedCommercialReferenceError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * Brain Rev100/Rev101: opaque upstream commercial *provenance* only - it
 * grants no acceptance, payment, legal, or checkout authority, and this
 * module has no function that derives or promotes acceptance from it. It is
 * checked for exact equality against the supplied `OfferBlueprintVersion`/
 * `SoldScope` by `compileProjectActivationProfile` itself (Rev101 step 2) -
 * this type carries no validation/authority logic of its own beyond
 * non-empty field shape.
 */
export interface AcceptedCommercialReference {
  readonly acceptanceRef: string;
  readonly sourceBlueprintId: OfferBlueprintVersion["blueprintId"];
  readonly sourceBlueprintVersion: OfferBlueprintVersion["version"];
  readonly soldScopeId: SoldScope["soldScopeId"];
  readonly outcomeContractRef: string;
}

export function createAcceptedCommercialReference(input: {
  acceptanceRef: unknown;
  sourceBlueprintId: unknown;
  sourceBlueprintVersion: unknown;
  soldScopeId: unknown;
  outcomeContractRef: unknown;
}): AcceptedCommercialReference {
  return {
    acceptanceRef: requireNonEmptyCommercialReferenceString(input.acceptanceRef, "acceptanceRef"),
    sourceBlueprintId: requireNonEmptyCommercialReferenceString(
      input.sourceBlueprintId,
      "sourceBlueprintId",
    ) as OfferBlueprintVersion["blueprintId"],
    sourceBlueprintVersion: requireNonEmptyCommercialReferenceString(
      input.sourceBlueprintVersion,
      "sourceBlueprintVersion",
    ),
    soldScopeId: requireNonEmptyCommercialReferenceString(
      input.soldScopeId,
      "soldScopeId",
    ) as SoldScope["soldScopeId"],
    outcomeContractRef: requireNonEmptyCommercialReferenceString(
      input.outcomeContractRef,
      "outcomeContractRef",
    ),
  };
}

/**
 * Which side of the AKILTA/customer boundary must act next. `NONE` is
 * reachable only when `state === "READY"`.
 */
export type ActivationActor = "NONE" | "CUSTOMER" | "AKILTA" | "HUMAN_REVIEW";

export type ActivationState = "READY" | "ACTION_REQUIRED";

export type MaterialPlatformDecisionStatus = "RESOLVED" | "ACTION_REQUIRED";

/**
 * Brain Rev101: a caller-supplied activation-time platform decision input
 * (e.g. which of several equally-valid delivery/operational options
 * applies to this activation) - never an output blocker-kind record. A
 * `RESOLVED` decision always carries a `selectedOptionRef` and
 * `actor: "NONE"`; an `ACTION_REQUIRED` decision always carries a real
 * actor and never a fabricated `selectedOptionRef` - both invariants are
 * enforced at construction, not left to caller discipline.
 */
export interface MaterialPlatformDecision {
  readonly decisionRef: string;
  readonly status: MaterialPlatformDecisionStatus;
  readonly reason: string;
  readonly actor: ActivationActor;
  readonly selectedOptionRef?: string;
}

export function createMaterialPlatformDecision(input: {
  decisionRef: unknown;
  status: unknown;
  reason: unknown;
  actor: unknown;
  selectedOptionRef?: unknown;
}): MaterialPlatformDecision {
  const decisionRef = requireNonEmptyPlatformDecisionString(input.decisionRef, "decisionRef");
  const reason = requireNonEmptyPlatformDecisionString(input.reason, "reason");
  if (input.status !== "RESOLVED" && input.status !== "ACTION_REQUIRED") {
    throw new InvalidMaterialPlatformDecisionError(
      'status must be "RESOLVED" or "ACTION_REQUIRED"',
    );
  }
  const status = input.status;
  if (
    input.actor !== "NONE" &&
    input.actor !== "CUSTOMER" &&
    input.actor !== "AKILTA" &&
    input.actor !== "HUMAN_REVIEW"
  ) {
    throw new InvalidMaterialPlatformDecisionError(
      "actor must be one of NONE, CUSTOMER, AKILTA, HUMAN_REVIEW",
    );
  }
  const actor = input.actor as ActivationActor;
  if (status === "RESOLVED") {
    if (actor !== "NONE") {
      throw new InvalidMaterialPlatformDecisionError("a RESOLVED decision must have actor NONE");
    }
    if (input.selectedOptionRef === undefined) {
      throw new InvalidMaterialPlatformDecisionError(
        "a RESOLVED decision requires a non-empty selectedOptionRef",
      );
    }
    const selectedOptionRef = requireNonEmptyPlatformDecisionString(input.selectedOptionRef, "selectedOptionRef");
    return { decisionRef, status, reason, actor, selectedOptionRef };
  }
  if (actor === "NONE") {
    throw new InvalidMaterialPlatformDecisionError(
      "an ACTION_REQUIRED decision must not have actor NONE",
    );
  }
  if (input.selectedOptionRef !== undefined) {
    throw new InvalidMaterialPlatformDecisionError(
      "an ACTION_REQUIRED decision must not carry a selectedOptionRef",
    );
  }
  return { decisionRef, status, reason, actor };
}

/**
 * One activation-time worker/model routing request. `WorkerRoutingRequest`
 * carries no identifier of its own, so `routeRef` is the caller-supplied
 * handle used to reject duplicate route requests within one activation
 * call and to name exactly which route a rejection refers to. The compiler
 * itself always calls `resolveWorkerRoute` - it never accepts a
 * caller-supplied routing decision as authority.
 */
export interface ActivationWorkerRouteInput {
  readonly routeRef: string;
  readonly request: WorkerRoutingRequest;
}

export interface NextRequiredAction {
  readonly code: string;
  readonly reason: string;
}

/**
 * Rev101 step 6: the compiler's own connection-readiness proof, never a
 * caller-supplied capability-admission claim. Only what a caller needs to
 * consume the connection is exposed - the requirement/binding id, an
 * optional opaque `SecretRef` id, and the verification evidence reference.
 */
export interface VerifiedConnectionObservation {
  readonly connectionRequirementId: ConnectionRequirement["connectionRequirementId"];
  readonly connectionBindingId: ConnectionBinding["connectionBindingId"];
  readonly secretRef?: string;
  readonly verificationEvidenceRef: string;
}

export interface ConsumedWorkerRoute {
  readonly routeRef: string;
  readonly decision: WorkerRoutingDecision;
}

/**
 * ADM-PROJ-001 "Project Activation / Effective Execution Profile" (Brain
 * Rev101): the versioned, composed readiness verdict for turning an
 * accepted commercial scope into admitted, wired `OutcomeJob`s - built
 * entirely from this repository's existing primitives. `state` is
 * `READY`/`ACTION_REQUIRED` only; an `ADMITTED` plan never by itself
 * implies `READY` (connection/platform-decision/routing gates still apply).
 *
 * `effectiveConfigRefs`/`effectivePolicyRefs` are independent caller-
 * supplied activation-time provenance (Rev107 F1) - never derived from
 * `recipe.requiredContextRefs`/`recipe.policyRefs`, so a material
 * effective-config/policy change is representable without mutating the
 * recipe itself. `platformDecision` is preserved on the profile whenever a
 * caller supplies one, whether `RESOLVED` or `ACTION_REQUIRED` (Rev107 F2)
 * - an unresolved decision still blocks activation, but its exact
 * provenance (including `decisionRef`) is never dropped from the output.
 */
export interface ProjectActivationProfile {
  readonly version: 1;
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly ownership: ProjectOwnershipRef;
  readonly acceptedCommercialReference: AcceptedCommercialReference;
  readonly soldScopeId: SoldScope["soldScopeId"];
  readonly blueprintId: OfferBlueprintVersion["blueprintId"];
  readonly blueprintVersion: OfferBlueprintVersion["version"];
  readonly recipeId: DeliveryRecipe["recipeId"];
  readonly recipeVersion: DeliveryRecipe["version"];
  readonly planId: ProjectPlanVersion["planId"];
  readonly planVersion: ProjectPlanVersion["version"];
  readonly effectiveConfigRefs: ReadonlyArray<string>;
  readonly effectivePolicyRefs: ReadonlyArray<string>;
  readonly platformDecision?: MaterialPlatformDecision;
  readonly verifiedConnections: ReadonlyArray<VerifiedConnectionObservation>;
  readonly consumedRoutes: ReadonlyArray<ConsumedWorkerRoute>;
  readonly state: ActivationState;
  readonly nextRequiredActor: ActivationActor;
  readonly nextRequiredAction?: NextRequiredAction;
  readonly unresolvedGates: ReadonlyArray<string>;
  readonly sourceFingerprint: string;
  readonly compiledAt: string;
}

/**
 * F2/Rev101: the existing `ProjectPlan`/`OutcomeJob` handoff artifacts are
 * returned alongside the profile rather than duplicated into it.
 * `jobs` is empty unless `profile.state === "READY"`.
 */
export interface ProjectActivationCompilation {
  readonly profile: ProjectActivationProfile;
  readonly plan: ProjectPlanVersion;
  readonly planAdmission: PlanAdmissionResult;
  readonly specs: ReadonlyArray<OutcomeJobSpec>;
  readonly jobAdmissions: ReadonlyArray<JobAdmissionResult>;
  readonly jobs: ReadonlyArray<OutcomeJob>;
}

function computeSourceFingerprint(input: {
  ownership: ProjectOwnershipRef;
  acceptedCommercialReference: AcceptedCommercialReference;
  soldScope: SoldScope;
  blueprint: OfferBlueprintVersion;
  recipe: DeliveryRecipe;
  plan: ProjectPlanVersion;
  effectiveConfigRefs: ReadonlyArray<string>;
  effectivePolicyRefs: ReadonlyArray<string>;
  platformDecision: MaterialPlatformDecision | undefined;
  verifiedConnections: ReadonlyArray<VerifiedConnectionObservation>;
  consumedRoutes: ReadonlyArray<{
    routeRef: string;
    request: WorkerRoutingRequest;
    decision: WorkerRoutingDecision;
  }>;
  state: ActivationState;
  nextRequiredActor: ActivationActor;
  nextRequiredAction: NextRequiredAction | undefined;
}): string {
  const canonical = JSON.stringify({
    ownership: input.ownership,
    acceptedCommercialReference: input.acceptedCommercialReference,
    soldScope: {
      soldScopeId: input.soldScope.soldScopeId,
      outcomeContractRef: input.soldScope.outcomeContractRef,
      includedRequirementIds: input.soldScope.includedRequirementIds,
      excludedRequirementIds: input.soldScope.excludedRequirementIds,
    },
    blueprint: {
      blueprintId: input.blueprint.blueprintId,
      version: input.blueprint.version,
      requirements: input.blueprint.requirements,
    },
    recipe: input.recipe,
    plan: {
      planId: input.plan.planId,
      version: input.plan.version,
      nodes: input.plan.nodes,
    },
    effectiveConfigRefs: input.effectiveConfigRefs,
    effectivePolicyRefs: input.effectivePolicyRefs,
    platformDecision: input.platformDecision ?? null,
    verifiedConnections: input.verifiedConnections,
    consumedRoutes: input.consumedRoutes,
    state: input.state,
    nextRequiredActor: input.nextRequiredActor,
    nextRequiredAction: input.nextRequiredAction ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function finish(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  ownership: ProjectOwnershipRef;
  acceptedCommercialReference: AcceptedCommercialReference;
  soldScope: SoldScope;
  blueprint: OfferBlueprintVersion;
  recipe: DeliveryRecipe;
  plan: ProjectPlanVersion;
  planAdmission: PlanAdmissionResult;
  specs: ReadonlyArray<OutcomeJobSpec>;
  jobAdmissions: ReadonlyArray<JobAdmissionResult>;
  effectiveConfigRefs: ReadonlyArray<string>;
  effectivePolicyRefs: ReadonlyArray<string>;
  now: string;
  state: ActivationState;
  nextRequiredActor: ActivationActor;
  nextRequiredAction: NextRequiredAction | undefined;
  unresolvedGates: ReadonlyArray<string>;
  platformDecision: MaterialPlatformDecision | undefined;
  verifiedConnections: ReadonlyArray<VerifiedConnectionObservation>;
  consumedRoutesForProfile: ReadonlyArray<ConsumedWorkerRoute>;
  consumedRoutesForFingerprint: ReadonlyArray<{
    routeRef: string;
    request: WorkerRoutingRequest;
    decision: WorkerRoutingDecision;
  }>;
  jobs: ReadonlyArray<OutcomeJob>;
}): ProjectActivationCompilation {
  const sourceFingerprint = computeSourceFingerprint({
    ownership: input.ownership,
    acceptedCommercialReference: input.acceptedCommercialReference,
    soldScope: input.soldScope,
    blueprint: input.blueprint,
    recipe: input.recipe,
    plan: input.plan,
    effectiveConfigRefs: input.effectiveConfigRefs,
    effectivePolicyRefs: input.effectivePolicyRefs,
    platformDecision: input.platformDecision,
    verifiedConnections: input.verifiedConnections,
    consumedRoutes: input.consumedRoutesForFingerprint,
    state: input.state,
    nextRequiredActor: input.nextRequiredActor,
    nextRequiredAction: input.nextRequiredAction,
  });

  const profile: ProjectActivationProfile = {
    version: 1,
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: input.project.projectId,
    ownership: input.ownership,
    acceptedCommercialReference: input.acceptedCommercialReference,
    soldScopeId: input.soldScope.soldScopeId,
    blueprintId: input.blueprint.blueprintId,
    blueprintVersion: input.blueprint.version,
    recipeId: input.recipe.recipeId,
    recipeVersion: input.recipe.version,
    planId: input.plan.planId,
    planVersion: input.plan.version,
    effectiveConfigRefs: input.effectiveConfigRefs,
    effectivePolicyRefs: input.effectivePolicyRefs,
    ...(input.platformDecision !== undefined ? { platformDecision: input.platformDecision } : {}),
    verifiedConnections: input.verifiedConnections,
    consumedRoutes: input.consumedRoutesForProfile,
    state: input.state,
    nextRequiredActor: input.nextRequiredActor,
    ...(input.nextRequiredAction !== undefined ? { nextRequiredAction: input.nextRequiredAction } : {}),
    unresolvedGates: input.unresolvedGates,
    sourceFingerprint,
    compiledAt: input.now,
  };

  return {
    profile,
    plan: input.plan,
    planAdmission: input.planAdmission,
    specs: input.specs,
    jobAdmissions: input.jobAdmissions,
    jobs: input.jobs,
  };
}

/**
 * Compiles a `ProjectActivationProfile`. Pure and deterministic: no
 * wall-clock read (the caller supplies `now`), no randomness, no
 * provider/model call, no persistence.
 *
 * Validation order (Brain Rev101), blocker priority when multiple
 * conditions exist: structural mismatch throws first; then plan scope/
 * readiness/approval; then required connection; then material platform
 * decision; then activation-time routing.
 *
 * 1. Structural coherence: `customer`/`project`/`ownership`/`soldScope` all
 *    belong to the given `tenantScope`/`project`. Throws
 *    `InvalidProjectActivationProfileError` on mismatch.
 * 2. `acceptedCommercialReference` must exactly equal the supplied
 *    `blueprint` (`blueprintId`/`version`) and `soldScope` (`soldScopeId`/
 *    `outcomeContractRef`) - no inference. Mismatch throws.
 * 3. `recipe.jobFamily` must equal `blueprint.blueprintId`. Mismatch
 *    throws.
 * 4. Call `compilePlan`, then `admitPlan`, then `deriveOutcomeJobSpecs`,
 *    then `admitJobs`, unconditionally and in that order.
 * 5. If `planAdmission` is not `ADMITTED`: `WAITING` on an unresolved
 *    sold-scope decision -> `CUSTOMER`; `WAITING` on `"plan-approval"` or
 *    `BLOCKED` (a structural/readiness defect) -> `HUMAN_REVIEW`. The
 *    exact admission reason is preserved; no jobs are wired.
 * 6. Every supplied `ConnectionRequirement` whose `requiredCapabilityRef`
 *    names a `REQUIRED`-disposition plan node must resolve, among the
 *    supplied `ConnectionBinding`s, to exactly one binding matching the
 *    exact requirement id + ownership, with `delegatedScope` re-checked
 *    against `minimumProviderScope`, and `connectionState === "VERIFIED"`.
 *    Zero matches -> `CUSTOMER` (accountOwner `CUSTOMER_OWNED`) or
 *    `AKILTA` (`AKILTA_MANAGED`); more than one -> `AKILTA` (ambiguous).
 *    Only the requirement/binding id, an optional opaque `SecretRef` id,
 *    and the verification evidence ref are ever exposed.
 * 7. A supplied `platformDecision` with `status: "ACTION_REQUIRED"` blocks
 *    with its own declared actor; `RESOLVED` (or absent) continues.
 * 8. For each supplied `ActivationWorkerRouteInput`, calls
 *    `resolveWorkerRoute`. A duplicate `routeRef` within one call throws.
 *    Any `REJECTED` routing decision -> `AKILTA`.
 * 9. Only once steps 1-8 are fully clean does this function call
 *    `wireAdmittedOutcomeJobs` and return `state: "READY"`,
 *    `nextRequiredActor: "NONE"`.
 */
export function compileProjectActivationProfile(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  ownership: ProjectOwnershipRef;
  acceptedCommercialReference: AcceptedCommercialReference;
  blueprint: OfferBlueprintVersion;
  soldScope: SoldScope;
  recipe: DeliveryRecipe;
  effectiveConfigRefs: unknown;
  effectivePolicyRefs: unknown;
  evidence?: ReadonlyArray<CustomerEvidenceItem>;
  planId: unknown;
  planVersionNumber?: unknown;
  readinessAssertions?: ReadonlyArray<EvidenceReadinessAssertion>;
  approval?: ApprovalReference;
  connectionRequirements?: ReadonlyArray<ConnectionRequirement>;
  connectionBindings?: ReadonlyArray<ConnectionBinding>;
  platformDecision?: MaterialPlatformDecision;
  workerRoutes?: ReadonlyArray<ActivationWorkerRouteInput>;
  now: unknown;
}): ProjectActivationCompilation {
  // Rev108 F2: AcceptedCommercialReference/MaterialPlatformDecision are
  // plain exported interfaces, not opaque/branded types - a caller can
  // construct one by hand without going through
  // createAcceptedCommercialReference/createMaterialPlatformDecision,
  // bypassing their own invariants entirely. Re-running the same factories
  // here (discarding their return value; only the validation side effect
  // matters) makes those invariants non-bypassable at this compiler
  // boundary, not just at construction time.
  createAcceptedCommercialReference(input.acceptedCommercialReference);
  if (input.platformDecision !== undefined) {
    createMaterialPlatformDecision(input.platformDecision);
  }

  // Step 1: structural coherence.
  if (input.customer.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProjectActivationProfileError(
      "customer does not belong to the given tenantScope",
    );
  }
  if (input.project.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProjectActivationProfileError(
      "project does not belong to the given tenantScope",
    );
  }
  if (input.project.customerId !== input.customer.customerId) {
    throw new InvalidProjectActivationProfileError(
      "project does not belong to the given customer",
    );
  }
  if (
    input.ownership.tenantId !== input.tenantScope.tenantId ||
    input.ownership.customerId !== input.customer.customerId ||
    input.ownership.projectId !== input.project.projectId
  ) {
    throw new InvalidProjectActivationProfileError(
      "ownership does not match the given tenantScope/customer/project",
    );
  }
  if (
    input.soldScope.tenantId !== input.tenantScope.tenantId ||
    input.soldScope.projectId !== input.project.projectId
  ) {
    throw new InvalidProjectActivationProfileError(
      "soldScope does not belong to the given tenantScope/project",
    );
  }
  const now = requireNonEmptyString(input.now, "now");

  // Step 2: commercial reference must exactly equal blueprint + soldScope.
  if (
    input.acceptedCommercialReference.sourceBlueprintId !== input.blueprint.blueprintId ||
    input.acceptedCommercialReference.sourceBlueprintVersion !== input.blueprint.version ||
    input.acceptedCommercialReference.soldScopeId !== input.soldScope.soldScopeId ||
    input.acceptedCommercialReference.outcomeContractRef !== input.soldScope.outcomeContractRef
  ) {
    throw new InvalidProjectActivationProfileError(
      "acceptedCommercialReference does not exactly match the given blueprint (blueprintId/version) and soldScope (soldScopeId/outcomeContractRef)",
    );
  }

  // Step 3: recipe must be bound to this exact blueprint's job family.
  if (input.recipe.jobFamily !== input.blueprint.blueprintId) {
    throw new InvalidProjectActivationProfileError(
      "recipe.jobFamily does not match blueprint.blueprintId",
    );
  }

  // effectiveConfigRefs/effectivePolicyRefs are independent, caller-supplied
  // activation-time provenance (Rev107 F1) - never derived from
  // recipe.requiredContextRefs/policyRefs, so a material effective-config/
  // policy change is representable without mutating the recipe itself.
  const effectiveConfigRefs = requireOpaqueStringArray(input.effectiveConfigRefs, "effectiveConfigRefs");
  const effectivePolicyRefs = requireOpaqueStringArray(input.effectivePolicyRefs, "effectivePolicyRefs");

  // Step 4: compile and admit the plan, unconditionally.
  const plan = compilePlan({
    tenantScope: input.tenantScope,
    project: input.project,
    planId: input.planId,
    ...(input.planVersionNumber !== undefined ? { version: input.planVersionNumber } : {}),
    blueprint: input.blueprint,
    soldScope: input.soldScope,
    ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
    now,
  });
  const planAdmission: PlanAdmissionResult = admitPlan({
    plan,
    blueprint: input.blueprint,
    ...(input.readinessAssertions !== undefined
      ? { readinessAssertions: input.readinessAssertions }
      : {}),
    ...(input.approval !== undefined ? { approval: input.approval } : {}),
  });
  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);

  const common = {
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    ownership: input.ownership,
    acceptedCommercialReference: input.acceptedCommercialReference,
    soldScope: input.soldScope,
    blueprint: input.blueprint,
    recipe: input.recipe,
    plan,
    planAdmission,
    specs,
    jobAdmissions,
    effectiveConfigRefs,
    effectivePolicyRefs,
    now,
  };

  // Step 5: interpret the PlanAdmissionResult.
  if (planAdmission.status !== "ADMITTED") {
    let actor: ActivationActor;
    let code: string;
    let reason: string;
    let gate: string;
    if (planAdmission.status === "BLOCKED") {
      actor = "HUMAN_REVIEW";
      code = "PLAN_ADMISSION_BLOCKED";
      reason = planAdmission.blockedReasons.join("; ");
      gate = "PLAN_ADMISSION";
    } else {
      const awaiting = planAdmission.awaiting;
      if (awaiting === undefined) {
        throw new InvalidProjectActivationProfileError(
          "internal error: WAITING plan admission with no awaiting entity",
        );
      }
      if (awaiting.entity === "plan-approval") {
        actor = "HUMAN_REVIEW";
        code = "PLAN_APPROVAL_REQUIRED";
        gate = "PLAN_APPROVAL";
      } else {
        actor = "CUSTOMER";
        code = "PLAN_SCOPE_DECISION_REQUIRED";
        gate = `PLAN_SCOPE:${awaiting.entity}`;
      }
      reason = awaiting.reason;
    }
    return finish({
      ...common,
      state: "ACTION_REQUIRED",
      nextRequiredActor: actor,
      nextRequiredAction: { code, reason },
      unresolvedGates: [gate],
      // Rev108 F1: a supplied platformDecision is provenance the caller
      // gave, not something this step evaluates - it must survive onto the
      // profile/fingerprint even when an earlier blocker (plan admission)
      // wins, exactly as it does for every other terminal outcome.
      platformDecision: input.platformDecision,
      verifiedConnections: [],
      consumedRoutesForProfile: [],
      consumedRoutesForFingerprint: [],
      jobs: [],
    });
  }

  // Step 6: connection readiness gate.
  const requiredRequirementIds = new Set(
    plan.nodes.filter((node) => node.disposition === "REQUIRED").map((node) => node.requirementId),
  );
  const connectionRequirements = input.connectionRequirements ?? [];
  const connectionBindings = input.connectionBindings ?? [];
  const verifiedConnections: VerifiedConnectionObservation[] = [];
  for (const requirement of connectionRequirements) {
    if (
      requirement.ownership.tenantId !== input.ownership.tenantId ||
      requirement.ownership.customerId !== input.ownership.customerId ||
      requirement.ownership.projectId !== input.ownership.projectId ||
      requirement.ownership.serviceRef !== input.ownership.serviceRef
    ) {
      throw new InvalidProjectActivationProfileError(
        `connectionRequirements entry "${requirement.connectionRequirementId}" does not belong to the given ownership`,
      );
    }
    if (!requiredRequirementIds.has(requirement.requiredCapabilityRef)) {
      // Not in scope for the current sold plan.
      continue;
    }
    const compatible = connectionBindings.filter((binding) => {
      if (binding.connectionRequirementId !== requirement.connectionRequirementId) {
        return false;
      }
      if (
        binding.ownership.tenantId !== requirement.ownership.tenantId ||
        binding.ownership.customerId !== requirement.ownership.customerId ||
        binding.ownership.projectId !== requirement.ownership.projectId ||
        binding.ownership.serviceRef !== requirement.ownership.serviceRef
      ) {
        // A binding for this requirement id bound to a different
        // customer/organization/project/service is never a valid
        // candidate, however VERIFIED it may be.
        return false;
      }
      if (requirement.minimumProviderScope.length > 0) {
        const allowed = new Set(requirement.minimumProviderScope);
        if (binding.delegatedScope.some((scope) => !allowed.has(scope))) {
          return false;
        }
      }
      return true;
    });
    const verified = compatible.filter((binding) => binding.connectionState === "VERIFIED");
    const actor: ActivationActor = requirement.accountOwner === "CUSTOMER_OWNED" ? "CUSTOMER" : "AKILTA";
    if (verified.length === 0) {
      return finish({
        ...common,
        state: "ACTION_REQUIRED",
        nextRequiredActor: actor,
        nextRequiredAction: {
          code: "CONNECTION_NOT_VERIFIED",
          reason: `no compatible VERIFIED ConnectionBinding found for connection requirement "${requirement.connectionRequirementId}" (capability "${requirement.requiredCapabilityRef}")`,
        },
        unresolvedGates: [`CONNECTION:${requirement.connectionRequirementId}`],
        platformDecision: input.platformDecision,
        // Rev108 F1: earlier requirements in this same loop that already
        // resolved to exactly one VERIFIED binding are preserved - a later
        // requirement's failure must never erase already-validated
        // provenance.
        verifiedConnections,
        consumedRoutesForProfile: [],
        consumedRoutesForFingerprint: [],
        jobs: [],
      });
    }
    if (verified.length > 1) {
      return finish({
        ...common,
        state: "ACTION_REQUIRED",
        nextRequiredActor: "AKILTA",
        nextRequiredAction: {
          code: "CONNECTION_AMBIGUOUS",
          reason: `multiple compatible VERIFIED ConnectionBindings found for connection requirement "${requirement.connectionRequirementId}"; exactly one is required`,
        },
        unresolvedGates: [`CONNECTION:${requirement.connectionRequirementId}`],
        platformDecision: input.platformDecision,
        verifiedConnections,
        consumedRoutesForProfile: [],
        consumedRoutesForFingerprint: [],
        jobs: [],
      });
    }
    const binding = verified[0]!;
    if (binding.verificationEvidenceRef === undefined) {
      throw new InvalidProjectActivationProfileError(
        `internal error: VERIFIED ConnectionBinding "${binding.connectionBindingId}" has no verificationEvidenceRef`,
      );
    }
    verifiedConnections.push({
      connectionRequirementId: requirement.connectionRequirementId,
      connectionBindingId: binding.connectionBindingId,
      ...(binding.secretRef !== undefined ? { secretRef: binding.secretRef } : {}),
      verificationEvidenceRef: binding.verificationEvidenceRef,
    });
  }

  // Step 7: material platform decision.
  let resolvedPlatformDecision: MaterialPlatformDecision | undefined;
  if (input.platformDecision !== undefined) {
    if (input.platformDecision.status === "ACTION_REQUIRED") {
      return finish({
        ...common,
        state: "ACTION_REQUIRED",
        nextRequiredActor: input.platformDecision.actor,
        nextRequiredAction: {
          code: "PLATFORM_DECISION_REQUIRED",
          reason: input.platformDecision.reason,
        },
        unresolvedGates: [`PLATFORM_DECISION:${input.platformDecision.decisionRef}`],
        // Rev107 F2: an ACTION_REQUIRED platform decision still blocks
        // activation, but its exact provenance (including decisionRef) must
        // survive onto the profile and fingerprint - it is never dropped
        // merely because it did not resolve.
        platformDecision: input.platformDecision,
        verifiedConnections,
        consumedRoutesForProfile: [],
        consumedRoutesForFingerprint: [],
        jobs: [],
      });
    }
    resolvedPlatformDecision = input.platformDecision;
  }

  // Step 8: worker routing.
  const workerRoutes = input.workerRoutes ?? [];
  const seenRouteRefs = new Set<string>();
  const consumedRoutesForProfile: ConsumedWorkerRoute[] = [];
  const consumedRoutesForFingerprint: Array<{
    routeRef: string;
    request: WorkerRoutingRequest;
    decision: WorkerRoutingDecision;
  }> = [];
  for (const routeInput of workerRoutes) {
    const routeRef = requireNonEmptyString(routeInput.routeRef, "workerRoutes[].routeRef");
    if (seenRouteRefs.has(routeRef)) {
      throw new InvalidProjectActivationProfileError(
        `duplicate workerRoutes routeRef "${routeRef}"`,
      );
    }
    seenRouteRefs.add(routeRef);
    const decision = resolveWorkerRoute(routeInput.request);
    consumedRoutesForProfile.push({ routeRef, decision });
    consumedRoutesForFingerprint.push({ routeRef, request: routeInput.request, decision });
    if (decision.status === "REJECTED") {
      return finish({
        ...common,
        state: "ACTION_REQUIRED",
        nextRequiredActor: "AKILTA",
        nextRequiredAction: {
          code: "WORKER_ROUTE_REJECTED",
          reason: `worker route "${routeRef}" was rejected: ${decision.reason}`,
        },
        unresolvedGates: [`WORKER_ROUTE:${routeRef}`],
        platformDecision: resolvedPlatformDecision,
        verifiedConnections,
        consumedRoutesForProfile,
        consumedRoutesForFingerprint,
        jobs: [],
      });
    }
  }

  // Step 9: wire admitted OutcomeJobs. Only reachable once every gate above
  // is clean. An ADMITTED plan alone never implies READY.
  const jobs = wireAdmittedOutcomeJobs({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    planAdmission,
    jobAdmissions,
    specs,
  });

  return finish({
    ...common,
    state: "READY",
    nextRequiredActor: "NONE",
    nextRequiredAction: undefined,
    unresolvedGates: [],
    platformDecision: resolvedPlatformDecision,
    verifiedConnections,
    consumedRoutesForProfile,
    consumedRoutesForFingerprint,
    jobs,
  });
}
