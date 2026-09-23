import { createHash } from "node:crypto";
import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "./project-ownership.js";
import type { OfferBlueprintVersion } from "./offer-blueprint.js";
import type { SoldScope } from "./sold-scope.js";
import type { CustomerEvidenceItem } from "./customer-evidence.js";
import { compilePlan, type ProjectPlanVersion } from "./project-plan.js";
import {
  admitPlan,
  admitJobs,
  type PlanAdmissionResult,
} from "./plan-admission.js";
import { deriveOutcomeJobSpecs } from "./outcome-job-spec.js";
import { wireAdmittedOutcomeJobs } from "./outcome-job-wiring.js";
import type { OutcomeJob } from "./outcome-job.js";
import type { EvidenceReadinessAssertion } from "./admission-readiness.js";
import type { ApprovalReference } from "./approval-reference.js";
import type { ConnectionRequirement } from "./connection-authority.js";
import type { CapabilityAdmission } from "./capability-admission.js";
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

export class InvalidProjectActivationProfileError extends Error {
  constructor(reason: string) {
    super(`Invalid ProjectActivationProfile input: ${reason}`);
    this.name = "InvalidProjectActivationProfileError";
  }
}

type AcceptedCommercialReferenceId = string & {
  readonly __brand: "AcceptedCommercialReferenceId";
};

/**
 * ADM-PROJ-001: the commercial-acceptance gate for activation, structurally
 * mirroring `approval-reference.ts`'s `ApprovalReference` (a version/
 * payload-bound approval for a `ProjectPlanVersion`) but bound instead to a
 * `SoldScope` - the commercial scope/acceptance record that exists *before*
 * a plan is even compiled (see `sold-scope.ts`). `payloadHash` reuses the
 * exact same deterministic-digest technique as `approval-reference.ts`'s
 * `hashPlanPayload` so a materially changed sold scope (a new included/
 * excluded requirement, a different outcome contract) invalidates a prior
 * acceptance rather than letting it silently carry forward, exactly as a
 * changed plan invalidates a prior `ApprovalReference`.
 */
export interface AcceptedCommercialReference {
  readonly acceptedCommercialReferenceId: AcceptedCommercialReferenceId;
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: Project["projectId"];
  readonly soldScopeId: SoldScope["soldScopeId"];
  readonly payloadHash: string;
  readonly acceptedAt: string;
  readonly acceptorRef: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
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

function hashSoldScopePayload(soldScope: SoldScope): string {
  const canonical = JSON.stringify({
    tenantId: soldScope.tenantId,
    projectId: soldScope.projectId,
    soldScopeId: soldScope.soldScopeId,
    outcomeContractRef: soldScope.outcomeContractRef,
    includedRequirementIds: soldScope.includedRequirementIds,
    excludedRequirementIds: soldScope.excludedRequirementIds,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function createAcceptedCommercialReference(input: {
  soldScope: SoldScope;
  acceptedCommercialReferenceId: unknown;
  acceptedAt: unknown;
  acceptorRef: unknown;
}): AcceptedCommercialReference {
  const acceptedCommercialReferenceId = requireNonEmptyString(
    input.acceptedCommercialReferenceId,
    "acceptedCommercialReferenceId",
  );
  const acceptedAt = requireNonEmptyString(input.acceptedAt, "acceptedAt");
  const acceptorRef = requireNonEmptyString(input.acceptorRef, "acceptorRef");
  return {
    acceptedCommercialReferenceId: acceptedCommercialReferenceId as AcceptedCommercialReferenceId,
    tenantId: input.soldScope.tenantId,
    projectId: input.soldScope.projectId,
    soldScopeId: input.soldScope.soldScopeId,
    payloadHash: hashSoldScopePayload(input.soldScope),
    acceptedAt,
    acceptorRef,
  };
}

/**
 * A material change to the sold scope (new/removed included or excluded
 * requirement, or a different outcome contract) invalidates a prior
 * acceptance, even for the exact same `soldScopeId` - the same "no material
 * change survives silently" discipline `isApprovalValidForPlan` applies to
 * `ProjectPlanVersion`.
 */
export function isCommercialReferenceValidForSoldScope(
  reference: AcceptedCommercialReference,
  soldScope: SoldScope,
): boolean {
  return (
    reference.tenantId === soldScope.tenantId &&
    reference.projectId === soldScope.projectId &&
    reference.soldScopeId === soldScope.soldScopeId &&
    reference.payloadHash === hashSoldScopePayload(soldScope)
  );
}

/**
 * Which side of the AKILTA/customer boundary must act next when a
 * `ProjectActivationProfile` is not `READY`. `HUMAN_REVIEW` is distinct from
 * `AKILTA` (an internal platform/dependency defect) - it names a human
 * reviewer decision specifically (e.g. a plan-approval gate), mirroring
 * `plan-admission.ts`'s own "exact awaited entity, never a generic waiting
 * placeholder" discipline. `NONE` is reachable only when `state === "READY"`.
 */
export type ActivationActor = "NONE" | "CUSTOMER" | "AKILTA" | "HUMAN_REVIEW";

export type ActivationState = "READY" | "BLOCKED" | "WAITING";

export type MaterialPlatformDecisionKind =
  | "COMMERCIAL_REFERENCE_INVALID"
  | "PLAN_BLOCKED"
  | "PLAN_APPROVAL_REQUIRED"
  | "PLAN_SCOPE_DECISION_REQUIRED"
  | "CONNECTION_NOT_VERIFIED"
  | "WORKER_ROUTE_REJECTED";

/**
 * The exact, single reason activation is not `READY` - never a generic
 * "blocked"/"waiting" placeholder, matching the same discipline
 * `PlanValidationFinding`/`AdmissionAwaiting`/`ReadinessGap` already
 * establish elsewhere in this domain layer. `relatedRef` names the specific
 * downstream reference (a `RequirementId`, a `connectionRequirementId`, a
 * `routeRef`) the decision is about, when one exists.
 */
export interface MaterialPlatformDecision {
  readonly kind: MaterialPlatformDecisionKind;
  readonly reason: string;
  readonly relatedRef?: string;
}

/**
 * One activation-time worker/model routing request. `WorkerRoutingRequest`
 * itself (`worker-routing-policy.ts`) carries no identifier of its own, so
 * `routeRef` is the caller-supplied handle this compiler uses to reject
 * duplicate route requests within a single activation call and to name
 * exactly which route a `WORKER_ROUTE_REJECTED` decision refers to.
 */
export interface ActivationWorkerRouteInput {
  readonly routeRef: string;
  readonly request: WorkerRoutingRequest;
}

/**
 * ADM-PROJ-001 "Project Activation / Effective Execution Profile": the
 * versioned, composed readiness verdict for turning an accepted commercial
 * scope into admitted, wired `OutcomeJob`s - built entirely from this
 * repository's existing primitives (`SoldScope`, `compilePlan`/`admitPlan`,
 * `ConnectionAuthority`/`CapabilityAdmission`, `resolveWorkerRoute`,
 * `wireAdmittedOutcomeJobs`). This module adds no new persistence, identity,
 * billing, or runtime surface - it is a pure compiler over inputs the
 * caller already holds, exactly as `compilePlan`/`admitPlan` are.
 */
export interface ProjectActivationProfile {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly ownership: ProjectOwnershipRef;
  readonly planId: ProjectPlanVersion["planId"];
  readonly planVersion: ProjectPlanVersion["version"];
  readonly state: ActivationState;
  readonly actor: ActivationActor;
  readonly decision?: MaterialPlatformDecision;
  readonly routingDecisions: ReadonlyArray<WorkerRoutingDecision>;
  readonly wiredJobs: ReadonlyArray<OutcomeJob>;
  readonly sourceFingerprint: string;
  readonly compiledAt: string;
}

function computeSourceFingerprint(input: {
  ownership: ProjectOwnershipRef;
  plan: ProjectPlanVersion;
  commercialReference: AcceptedCommercialReference;
  state: ActivationState;
  actor: ActivationActor;
  decision: MaterialPlatformDecision | undefined;
  routingDecisions: ReadonlyArray<WorkerRoutingDecision>;
  wiredJobIds: ReadonlyArray<string>;
}): string {
  const canonical = JSON.stringify({
    ownership: input.ownership,
    planId: input.plan.planId,
    planVersion: input.plan.version,
    sourceBlueprintId: input.plan.sourceBlueprintId,
    sourceBlueprintVersion: input.plan.sourceBlueprintVersion,
    sourceSoldScopeId: input.plan.sourceSoldScopeId,
    commercialReferenceId: input.commercialReference.acceptedCommercialReferenceId,
    commercialPayloadHash: input.commercialReference.payloadHash,
    state: input.state,
    actor: input.actor,
    decision: input.decision ?? null,
    routingDecisions: input.routingDecisions,
    wiredJobIds: input.wiredJobIds,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function buildProfile(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  ownership: ProjectOwnershipRef;
  plan: ProjectPlanVersion;
  commercialReference: AcceptedCommercialReference;
  state: ActivationState;
  actor: ActivationActor;
  decision?: MaterialPlatformDecision;
  routingDecisions: ReadonlyArray<WorkerRoutingDecision>;
  wiredJobs: ReadonlyArray<OutcomeJob>;
  now: string;
}): ProjectActivationProfile {
  const sourceFingerprint = computeSourceFingerprint({
    ownership: input.ownership,
    plan: input.plan,
    commercialReference: input.commercialReference,
    state: input.state,
    actor: input.actor,
    decision: input.decision,
    routingDecisions: input.routingDecisions,
    wiredJobIds: input.wiredJobs.map((job) => job.jobId),
  });
  return {
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: input.project.projectId,
    ownership: input.ownership,
    planId: input.plan.planId,
    planVersion: input.plan.version,
    state: input.state,
    actor: input.actor,
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    routingDecisions: input.routingDecisions,
    wiredJobs: input.wiredJobs,
    sourceFingerprint,
    compiledAt: input.now,
  };
}

/**
 * Compiles a `ProjectActivationProfile`. Pure and deterministic: no wall-
 * clock read (the caller supplies `now`), no randomness, no provider/model
 * call, no persistence - identical inputs always produce an identical
 * profile (`sourceFingerprint` included), the same replay guarantee
 * `admitPlan`/`compilePlan` already provide.
 *
 * Validation order (fails closed at the first unmet gate; a caller-
 * malformed input throws rather than producing a business decision):
 *
 * 1. Structural coherence: `customer`/`project`/`soldScope` all belong to
 *    the given `tenantScope`/`project`, and `acceptedCommercialReference`
 *    belongs to the given `tenantScope`/`project`. Throws on mismatch (a
 *    caller-construction error, not an activation-readiness gap).
 * 2. Compile the plan (`compilePlan`) - deterministic derivation, not a
 *    gate; always succeeds on structurally valid input.
 * 3. Commercial-acceptance gate: `acceptedCommercialReference` must be
 *    valid for the exact current `soldScope`
 *    (`isCommercialReferenceValidForSoldScope`). Missing/stale ->
 *    `BLOCKED`, actor `CUSTOMER`.
 * 4. Admit the plan (`admitPlan`).
 * 5. Interpret the `PlanAdmissionResult`: `BLOCKED` -> `BLOCKED`/`AKILTA`
 *    (a structural dependency/readiness defect is a platform
 *    responsibility, not directly actionable by the customer or a
 *    reviewer); `WAITING` with `awaiting.entity === "plan-approval"` ->
 *    `WAITING`/`HUMAN_REVIEW`; `WAITING` with `awaiting.entity` a
 *    `RequirementId` (an unresolved sold-scope decision) ->
 *    `WAITING`/`CUSTOMER`; `ADMITTED` -> continue.
 * 6. Derive and admit `OutcomeJobSpec`s (`deriveOutcomeJobSpecs`/
 *    `admitJobs`) - already `ADMITTED` on every spec at this point, since
 *    `admitJobs` mirrors a plan's own `ADMITTED` status, but the call is
 *    still made explicitly rather than assumed.
 * 7. Connection/capability readiness gate: every supplied
 *    `connectionRequirements` entry whose `requiredCapabilityRef` names a
 *    `REQUIRED`-disposition plan node must have a matching
 *    `capabilityAdmissions` entry with `status === "VERIFIED_AVAILABLE"`.
 *    A missing/unverified one -> `BLOCKED`, actor `CUSTOMER` when
 *    `requirement.accountOwner === "CUSTOMER_OWNED"`, else `AKILTA`.
 * 8. Worker routing: for each supplied `ActivationWorkerRouteInput`, calls
 *    `resolveWorkerRoute`. A duplicate `routeRef` within one call throws
 *    (malformed input, the same discipline `createDeliveryRecipe` applies
 *    to duplicate stepId/gateId). Any `REJECTED` routing decision ->
 *    `BLOCKED`, actor `AKILTA`.
 * 9. Only once steps 1-8 are fully clean does this function call
 *    `wireAdmittedOutcomeJobs` and return `state: "READY"`,
 *    `actor: "NONE"`, no `decision`.
 */
export function compileProjectActivationProfile(input: {
  tenantScope: TenantScope;
  customer: Customer;
  project: Project;
  acceptedCommercialReference: AcceptedCommercialReference;
  blueprint: OfferBlueprintVersion;
  soldScope: SoldScope;
  evidence?: ReadonlyArray<CustomerEvidenceItem>;
  planId: unknown;
  planVersionNumber?: unknown;
  readinessAssertions?: ReadonlyArray<EvidenceReadinessAssertion>;
  approval?: ApprovalReference;
  connectionRequirements?: ReadonlyArray<ConnectionRequirement>;
  capabilityAdmissions?: ReadonlyArray<CapabilityAdmission>;
  workerRoutes?: ReadonlyArray<ActivationWorkerRouteInput>;
  now: unknown;
}): ProjectActivationProfile {
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
    input.soldScope.tenantId !== input.tenantScope.tenantId ||
    input.soldScope.projectId !== input.project.projectId
  ) {
    throw new InvalidProjectActivationProfileError(
      "soldScope does not belong to the given tenantScope/project",
    );
  }
  if (
    input.acceptedCommercialReference.tenantId !== input.tenantScope.tenantId ||
    input.acceptedCommercialReference.projectId !== input.project.projectId
  ) {
    throw new InvalidProjectActivationProfileError(
      "acceptedCommercialReference does not belong to the given tenantScope/project",
    );
  }
  const now = requireNonEmptyString(input.now, "now");
  const ownership = createProjectOwnershipRef({
    tenantId: input.tenantScope.tenantId,
    customerId: input.customer.customerId,
    projectId: input.project.projectId,
  });

  // Step 2: compile the plan (deterministic derivation, not a gate).
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

  // Step 3: commercial-acceptance gate.
  if (!isCommercialReferenceValidForSoldScope(input.acceptedCommercialReference, input.soldScope)) {
    return buildProfile({
      tenantScope: input.tenantScope,
      customer: input.customer,
      project: input.project,
      ownership,
      plan,
      commercialReference: input.acceptedCommercialReference,
      state: "BLOCKED",
      actor: "CUSTOMER",
      decision: {
        kind: "COMMERCIAL_REFERENCE_INVALID",
        reason:
          "acceptedCommercialReference is missing or does not match the exact current sold scope",
        relatedRef: input.soldScope.soldScopeId,
      },
      routingDecisions: [],
      wiredJobs: [],
      now,
    });
  }

  // Step 4: admit the plan.
  const planAdmission: PlanAdmissionResult = admitPlan({
    plan,
    blueprint: input.blueprint,
    ...(input.readinessAssertions !== undefined
      ? { readinessAssertions: input.readinessAssertions }
      : {}),
    ...(input.approval !== undefined ? { approval: input.approval } : {}),
  });

  // Step 5: interpret the PlanAdmissionResult.
  if (planAdmission.status === "BLOCKED") {
    return buildProfile({
      tenantScope: input.tenantScope,
      customer: input.customer,
      project: input.project,
      ownership,
      plan,
      commercialReference: input.acceptedCommercialReference,
      state: "BLOCKED",
      actor: "AKILTA",
      decision: {
        kind: "PLAN_BLOCKED",
        reason: planAdmission.blockedReasons.join("; "),
      },
      routingDecisions: [],
      wiredJobs: [],
      now,
    });
  }
  if (planAdmission.status === "WAITING") {
    const awaiting = planAdmission.awaiting;
    if (awaiting === undefined) {
      throw new InvalidProjectActivationProfileError(
        "internal error: WAITING plan admission with no awaiting entity",
      );
    }
    const isApprovalWait = awaiting.entity === "plan-approval";
    return buildProfile({
      tenantScope: input.tenantScope,
      customer: input.customer,
      project: input.project,
      ownership,
      plan,
      commercialReference: input.acceptedCommercialReference,
      state: "WAITING",
      actor: isApprovalWait ? "HUMAN_REVIEW" : "CUSTOMER",
      decision: {
        kind: isApprovalWait ? "PLAN_APPROVAL_REQUIRED" : "PLAN_SCOPE_DECISION_REQUIRED",
        reason: awaiting.reason,
        relatedRef: awaiting.entity,
      },
      routingDecisions: [],
      wiredJobs: [],
      now,
    });
  }

  // Step 6: derive and admit OutcomeJobSpecs.
  const specs = deriveOutcomeJobSpecs(plan);
  const jobAdmissions = admitJobs(planAdmission, specs);

  // Step 7: connection/capability readiness gate.
  const requiredRequirementIds = new Set(
    plan.nodes.filter((node) => node.disposition === "REQUIRED").map((node) => node.requirementId),
  );
  const connectionRequirements = input.connectionRequirements ?? [];
  const capabilityAdmissions = input.capabilityAdmissions ?? [];
  for (const requirement of connectionRequirements) {
    if (
      requirement.ownership.tenantId !== ownership.tenantId ||
      requirement.ownership.customerId !== ownership.customerId ||
      requirement.ownership.projectId !== ownership.projectId ||
      requirement.ownership.serviceRef !== ownership.serviceRef
    ) {
      throw new InvalidProjectActivationProfileError(
        `connectionRequirements entry "${requirement.connectionRequirementId}" does not belong to the given tenantScope/customer/project`,
      );
    }
    if (!requiredRequirementIds.has(requirement.requiredCapabilityRef)) {
      // Not in scope for the current sold plan (e.g. a CONDITIONAL
      // requirement that was excluded) - readiness is not required.
      continue;
    }
    const admission = capabilityAdmissions.find(
      (candidate) =>
        candidate.requiredCapabilityRef === requirement.requiredCapabilityRef &&
        candidate.ownership.tenantId === ownership.tenantId &&
        candidate.ownership.customerId === ownership.customerId &&
        candidate.ownership.projectId === ownership.projectId &&
        candidate.ownership.serviceRef === ownership.serviceRef,
    );
    if (admission === undefined || admission.status !== "VERIFIED_AVAILABLE") {
      return buildProfile({
        tenantScope: input.tenantScope,
        customer: input.customer,
        project: input.project,
        ownership,
        plan,
        commercialReference: input.acceptedCommercialReference,
        state: "BLOCKED",
        actor: requirement.accountOwner === "CUSTOMER_OWNED" ? "CUSTOMER" : "AKILTA",
        decision: {
          kind: "CONNECTION_NOT_VERIFIED",
          reason: `connection requirement "${requirement.connectionRequirementId}" (capability "${requirement.requiredCapabilityRef}") has no VERIFIED_AVAILABLE capability admission`,
          relatedRef: requirement.connectionRequirementId,
        },
        routingDecisions: [],
        wiredJobs: [],
        now,
      });
    }
  }

  // Step 8: worker routing.
  const workerRoutes = input.workerRoutes ?? [];
  const seenRouteRefs = new Set<string>();
  const routingDecisions: WorkerRoutingDecision[] = [];
  for (const routeInput of workerRoutes) {
    const routeRef = requireNonEmptyString(routeInput.routeRef, "workerRoutes[].routeRef");
    if (seenRouteRefs.has(routeRef)) {
      throw new InvalidProjectActivationProfileError(
        `duplicate workerRoutes routeRef "${routeRef}"`,
      );
    }
    seenRouteRefs.add(routeRef);
    const decision = resolveWorkerRoute(routeInput.request);
    routingDecisions.push(decision);
    if (decision.status === "REJECTED") {
      return buildProfile({
        tenantScope: input.tenantScope,
        customer: input.customer,
        project: input.project,
        ownership,
        plan,
        commercialReference: input.acceptedCommercialReference,
        state: "BLOCKED",
        actor: "AKILTA",
        decision: {
          kind: "WORKER_ROUTE_REJECTED",
          reason: `worker route "${routeRef}" was rejected: ${decision.reason}`,
          relatedRef: routeRef,
        },
        routingDecisions,
        wiredJobs: [],
        now,
      });
    }
  }

  // Step 9: wire admitted OutcomeJobs. Only reachable once every gate above
  // is clean.
  const wiredJobs = wireAdmittedOutcomeJobs({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    planAdmission,
    jobAdmissions,
    specs,
  });

  return buildProfile({
    tenantScope: input.tenantScope,
    customer: input.customer,
    project: input.project,
    ownership,
    plan,
    commercialReference: input.acceptedCommercialReference,
    state: "READY",
    actor: "NONE",
    routingDecisions,
    wiredJobs,
    now,
  });
}
