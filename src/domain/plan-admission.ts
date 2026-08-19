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
