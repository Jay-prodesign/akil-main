import type { ProjectPlanVersion } from "./project-plan.js";
import type { OfferBlueprintVersion } from "./offer-blueprint.js";
import type { OutcomeJobSpec } from "./outcome-job-spec.js";
import { validatePlan } from "./project-plan-validation.js";
import { isApprovalValidForPlan, type ApprovalReference } from "./approval-reference.js";
import { evaluateReadiness, type EvidenceReadinessAssertion } from "./admission-readiness.js";

export class InvalidPlanAdmissionError extends Error {
  constructor(reason: string) {
    super(`Invalid plan admission input: ${reason}`);
    this.name = "InvalidPlanAdmissionError";
  }
}

export type AdmissionStatus = "ADMITTED" | "BLOCKED" | "WAITING";

/**
 * DEL-003 second bounded slice #5: exact awaited entity/reason - never a
 * generic "waiting" placeholder. `entity` is either the exact
 * RequirementId whose disposition is UNKNOWN (a customer scope decision
 * is needed) or the literal string "plan-approval" (a version/payload-
 * bound approval is needed).
 */
export interface AdmissionAwaiting {
  readonly entity: string;
  readonly reason: string;
}

/**
 * DEL-003 second bounded slice #2/#3: deterministic plan-level admission
 * decision. Deliberately built on top of the already-verified DEL-003
 * first-slice `validatePlan`/`isApprovalValidForPlan` rather than
 * re-deriving equivalent BLOCKED/UNKNOWN detection - this bounded slice
 * adds only the ADMITTED/BLOCKED/WAITING decision and approval-gating on
 * top of those existing, already-tested primitives.
 */
export interface PlanAdmissionResult {
  readonly tenantId: ProjectPlanVersion["tenantId"];
  readonly projectId: ProjectPlanVersion["projectId"];
  readonly planId: ProjectPlanVersion["planId"];
  readonly planVersion: ProjectPlanVersion["version"];
  readonly status: AdmissionStatus;
  readonly blockedReasons: ReadonlyArray<string>;
  readonly awaiting?: AdmissionAwaiting;
  readonly evaluatedApprovalId?: ApprovalReference["approvalId"];
}

const ADMISSION_STATUSES: ReadonlySet<string> = new Set<AdmissionStatus>([
  "ADMITTED",
  "BLOCKED",
  "WAITING",
]);

function requireNonEmptyStringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPlanAdmissionError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Rev77 F3 correction: `admitPlan` itself never produces a status/field
 * combination outside this fixed shape - each `AdmissionStatus` has exactly
 * one legal combination of `blockedReasons`/`awaiting`/`evaluatedApprovalId`
 * (see `admitPlan`'s three return branches). Without enforcing that same
 * invariant on replay, a corrupted or forged persisted line could carry an
 * impossible combination (e.g. `status: "ADMITTED"` with a populated
 * `blockedReasons`, or `"BLOCKED"` with an `awaiting` entity) and still pass
 * per-field shape validation, silently handing an internally-inconsistent
 * result to `reconstructPlanAdmissionState`/`recordAnswer`.
 */
function requireConsistentAdmissionShape(result: PlanAdmissionResult): void {
  if (result.status === "ADMITTED") {
    if (result.blockedReasons.length > 0) {
      throw new InvalidPlanAdmissionError('status "ADMITTED" must not carry any blockedReasons');
    }
    if (result.awaiting !== undefined) {
      throw new InvalidPlanAdmissionError('status "ADMITTED" must not carry an awaiting entity');
    }
    if (result.evaluatedApprovalId === undefined) {
      throw new InvalidPlanAdmissionError('status "ADMITTED" must carry an evaluatedApprovalId');
    }
    return;
  }
  if (result.status === "BLOCKED") {
    if (result.blockedReasons.length === 0) {
      throw new InvalidPlanAdmissionError('status "BLOCKED" must carry at least one blockedReason');
    }
    if (result.awaiting !== undefined) {
      throw new InvalidPlanAdmissionError('status "BLOCKED" must not carry an awaiting entity');
    }
    if (result.evaluatedApprovalId !== undefined) {
      throw new InvalidPlanAdmissionError('status "BLOCKED" must not carry an evaluatedApprovalId');
    }
    return;
  }
  // WAITING
  if (result.blockedReasons.length > 0) {
    throw new InvalidPlanAdmissionError('status "WAITING" must not carry any blockedReasons');
  }
  if (result.awaiting === undefined) {
    throw new InvalidPlanAdmissionError('status "WAITING" must carry an awaiting entity');
  }
  if (result.evaluatedApprovalId !== undefined) {
    throw new InvalidPlanAdmissionError('status "WAITING" must not carry an evaluatedApprovalId');
  }
}

/**
 * AUD-DURABILITY-GAP: re-validates an already-persisted `PlanAdmissionResult`
 * (e.g. read back from the durable plan-admission store) against this
 * type's own shape, rather than trusting a blind `JSON.parse(...) as
 * PlanAdmissionResult` cast on replay. `admitPlan` itself has no "reconstruct
 * from raw JSON" mode (it recomputes a fresh result from live plan/blueprint
 * inputs), so this is the ingress-validation counterpart for durable replay:
 * a corrupted or forged persisted record fails closed here instead of
 * silently flowing into the plan-admission reducer.
 *
 * Rev77 F3 correction: also enforces `requireConsistentAdmissionShape` below
 * - per-field shape validation alone let an impossible ADMITTED/BLOCKED/
 * WAITING combination (see that function) pass replay validation.
 */
export function validatePersistedPlanAdmissionResult(raw: unknown): PlanAdmissionResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidPlanAdmissionError("persisted PlanAdmissionResult must be an object");
  }
  const record = raw as Record<string, unknown>;
  const tenantId = requireNonEmptyStringField(record.tenantId, "tenantId");
  const projectId = requireNonEmptyStringField(record.projectId, "projectId");
  const planId = requireNonEmptyStringField(record.planId, "planId");
  if (typeof record.planVersion !== "number" || !Number.isInteger(record.planVersion) || record.planVersion < 1) {
    throw new InvalidPlanAdmissionError("planVersion must be a positive integer");
  }
  if (typeof record.status !== "string" || !ADMISSION_STATUSES.has(record.status)) {
    throw new InvalidPlanAdmissionError('status must be one of "ADMITTED", "BLOCKED", "WAITING"');
  }
  if (!Array.isArray(record.blockedReasons)) {
    throw new InvalidPlanAdmissionError("blockedReasons must be an array");
  }
  const blockedReasons = record.blockedReasons.map((reason, index) =>
    requireNonEmptyStringField(reason, `blockedReasons[${index}]`),
  );
  let awaiting: AdmissionAwaiting | undefined;
  if (record.awaiting !== undefined) {
    if (typeof record.awaiting !== "object" || record.awaiting === null) {
      throw new InvalidPlanAdmissionError("awaiting must be an object when present");
    }
    const awaitingRecord = record.awaiting as Record<string, unknown>;
    awaiting = {
      entity: requireNonEmptyStringField(awaitingRecord.entity, "awaiting.entity"),
      reason: requireNonEmptyStringField(awaitingRecord.reason, "awaiting.reason"),
    };
  }
  const evaluatedApprovalId =
    record.evaluatedApprovalId !== undefined
      ? requireNonEmptyStringField(record.evaluatedApprovalId, "evaluatedApprovalId")
      : undefined;
  const result: PlanAdmissionResult = {
    tenantId: tenantId as PlanAdmissionResult["tenantId"],
    projectId: projectId as PlanAdmissionResult["projectId"],
    planId: planId as PlanAdmissionResult["planId"],
    planVersion: record.planVersion as PlanAdmissionResult["planVersion"],
    status: record.status as AdmissionStatus,
    blockedReasons,
    ...(awaiting !== undefined ? { awaiting } : {}),
    ...(evaluatedApprovalId !== undefined
      ? { evaluatedApprovalId: evaluatedApprovalId as ApprovalReference["approvalId"] }
      : {}),
  };
  requireConsistentAdmissionShape(result);
  return result;
}

function planIdentity(
  plan: ProjectPlanVersion,
): Pick<PlanAdmissionResult, "tenantId" | "projectId" | "planId" | "planVersion"> {
  return {
    tenantId: plan.tenantId,
    projectId: plan.projectId,
    planId: plan.planId,
    planVersion: plan.version,
  };
}

/**
 * T1-T3/T6/T9: fails closed by construction - every branch either returns
 * BLOCKED/WAITING with an explicit reason or requires every prerequisite
 * (plan completeness, capability/access/evidence readiness, AND a
 * version/payload-matching approval) to be simultaneously satisfied before
 * returning ADMITTED. Pure and deterministic: identical inputs always
 * produce an identical result, so pure-function "replay" is satisfied by
 * construction; durable restart/resume authority (T4/T7/T8) is provided
 * separately by `durable-plan-admission-store.ts`, which persists this
 * function's result rather than relying on recomputation alone - see that
 * module's doc comment for why recomputation alone is not sufficient
 * (Brain CHANGES_REQUIRED F2, DEL-003 second slice round 1).
 *
 * F1 correction: `readinessAssertions` gates every REQUIRED requirement's
 * capability/access/evidence readiness (`evaluateReadiness`). Per the
 * packet's own minimum test contract (T2 vs T3), a readiness gap is a
 * BLOCKED finding - distinct from an unresolved customer scope decision or
 * missing approval, both of which remain WAITING. Readiness is evaluated
 * only once the plan is structurally COMPLETE: an incomplete plan's own
 * BLOCKED/WAITING disposition already takes precedence and is unaffected by
 * readiness evidence.
 */
export function admitPlan(input: {
  plan: ProjectPlanVersion;
  blueprint: OfferBlueprintVersion;
  readinessAssertions?: ReadonlyArray<EvidenceReadinessAssertion>;
  approval?: ApprovalReference;
}): PlanAdmissionResult {
  const validation = validatePlan(input.plan, input.blueprint);

  if (validation.status === "INCOMPLETE") {
    // A BLOCKED or missing-coverage finding is a structural/dependency
    // failure, not something a customer answer alone can resolve - it
    // takes precedence over any UNKNOWN finding also present (T2 fails
    // closed ahead of T3's more narrowly actionable WAITING).
    const blocking = validation.findings.filter(
      (finding) =>
        finding.code === "BLOCKED_MANDATORY_REQUIREMENT" ||
        finding.code === "MISSING_REQUIRED_COVERAGE",
    );
    if (blocking.length > 0) {
      return {
        ...planIdentity(input.plan),
        status: "BLOCKED",
        blockedReasons: blocking.map((finding) => finding.message),
      };
    }
    const unknown = validation.findings.find(
      (finding) => finding.code === "UNKNOWN_MANDATORY_REQUIREMENT",
    );
    if (unknown === undefined) {
      throw new InvalidPlanAdmissionError(
        "internal error: INCOMPLETE validation with no blocking or unknown finding",
      );
    }
    return {
      ...planIdentity(input.plan),
      status: "WAITING",
      blockedReasons: [],
      awaiting: { entity: unknown.requirementId, reason: unknown.message },
    };
  }

  const requiredRequirementIds = input.plan.nodes
    .filter((node) => node.disposition === "REQUIRED")
    .map((node) => node.requirementId);
  const readiness = evaluateReadiness({
    plan: input.plan,
    requiredRequirementIds,
    assertions: input.readinessAssertions ?? [],
  });
  if (readiness.status === "NOT_READY") {
    return {
      ...planIdentity(input.plan),
      status: "BLOCKED",
      blockedReasons: readiness.gaps.map((gap) => gap.reason),
    };
  }

  if (input.approval === undefined || !isApprovalValidForPlan(input.approval, input.plan)) {
    // T6: a stale or materially-changed-plan approval is indistinguishable
    // here from no approval at all - isApprovalValidForPlan already fails
    // closed on any version/payload mismatch.
    return {
      ...planIdentity(input.plan),
      status: "WAITING",
      blockedReasons: [],
      awaiting: {
        entity: "plan-approval",
        reason:
          "plan is complete but requires a version/payload-matching approval before admission",
      },
    };
  }

  return {
    ...planIdentity(input.plan),
    status: "ADMITTED",
    blockedReasons: [],
    evaluatedApprovalId: input.approval.approvalId,
  };
}

export interface JobAdmissionResult {
  readonly tenantId: PlanAdmissionResult["tenantId"];
  readonly projectId: PlanAdmissionResult["projectId"];
  readonly planId: PlanAdmissionResult["planId"];
  readonly planVersion: PlanAdmissionResult["planVersion"];
  readonly specId: OutcomeJobSpec["specId"];
  readonly requirementId: OutcomeJobSpec["requirementId"];
  readonly status: AdmissionStatus;
  readonly reason?: string;
}

/**
 * T9: plan-level admission is a whole-plan gate - every derived job
 * mirrors the plan's own BLOCKED/WAITING status rather than being
 * independently (and inconsistently) evaluated when the plan itself is
 * not ADMITTED. T5: every spec must belong to the exact admitted plan
 * (tenant/project/plan/version binding) or this fails closed by throwing,
 * rather than silently admitting a job from a different plan.
 */
export function admitJobs(
  planAdmission: PlanAdmissionResult,
  specs: ReadonlyArray<OutcomeJobSpec>,
): ReadonlyArray<JobAdmissionResult> {
  for (const [index, spec] of specs.entries()) {
    if (
      spec.tenantId !== planAdmission.tenantId ||
      spec.projectId !== planAdmission.projectId ||
      spec.planId !== planAdmission.planId ||
      spec.planVersion !== planAdmission.planVersion
    ) {
      throw new InvalidPlanAdmissionError(
        `specs[${index}] does not belong to the given plan admission result's tenant/project/plan/version`,
      );
    }
  }

  if (planAdmission.status !== "ADMITTED") {
    const reason =
      planAdmission.status === "BLOCKED"
        ? planAdmission.blockedReasons.join("; ")
        : planAdmission.awaiting?.reason;
    return specs.map((spec) => ({
      tenantId: planAdmission.tenantId,
      projectId: planAdmission.projectId,
      planId: planAdmission.planId,
      planVersion: planAdmission.planVersion,
      specId: spec.specId,
      requirementId: spec.requirementId,
      status: planAdmission.status,
      ...(reason !== undefined ? { reason } : {}),
    }));
  }

  return specs.map((spec) => ({
    tenantId: planAdmission.tenantId,
    projectId: planAdmission.projectId,
    planId: planAdmission.planId,
    planVersion: planAdmission.planVersion,
    specId: spec.specId,
    requirementId: spec.requirementId,
    status: "ADMITTED",
  }));
}
