export class InvalidWorkerRoutingRequestError extends Error {
  constructor(reason: string) {
    super(`Invalid WorkerRoutingRequest: ${reason}`);
    this.name = "InvalidWorkerRoutingRequestError";
  }
}

/**
 * V5 Workstream B (Worker/Model Routing Policy), §6 text: "choose among
 * admitted humans and AI workers using evidence rather than provider
 * prestige or availability" - this module is fully provider-neutral, so a
 * worker is represented only by an opaque `workerId`, never a hard-coded
 * vendor/model name. `trustStatus` is the admission dimension - "provider
 * availability != admission != authority" (§6) - so an `AVAILABLE` worker
 * that is not `ADMITTED` can never be selected regardless of cost or
 * position in a caller-supplied candidate list.
 */
export type WorkerTrustStatus = "ADMITTED" | "UNTRUSTED" | "REVOKED";

/**
 * §6: "provider outage degrades gracefully." `UNAVAILABLE`/`DEGRADED`
 * workers are never selected; a caller supplying a fallback candidate
 * after an unavailable primary is exercising ordinary graceful
 * degradation, not a special code path - the same eligibility filter
 * applies uniformly to every candidate, including its tool/policy/
 * authority checks (a fallback can never route on relaxed requirements).
 */
export type WorkerAvailability = "AVAILABLE" | "UNAVAILABLE" | "DEGRADED";

/**
 * §6: "high-risk actions may require different executor/reviewer
 * separation." `maxRiskLevel` is the highest risk tier this worker is
 * declared/evaluated to be authorized for - a worker whose `maxRiskLevel`
 * is `STANDARD` can never be selected for `HIGH_RISK` work, no matter how
 * cheap or available it is.
 */
export type WorkerRiskLevel = "STANDARD" | "HIGH_RISK";

/**
 * §6 required semantics: "provider availability != admission != authority."
 * `authorityLevel` is a distinct dimension from `trustStatus` (admission)
 * and `maxRiskLevel` (risk tolerance) - it represents the explicit
 * authority a worker has been granted (e.g. to act on `ELEVATED`-authority
 * routes such as those touching protected/high-trust scope), and is never
 * inferred from admission or risk tolerance alone. `ELEVATED` satisfies a
 * route requiring either level; `STANDARD` satisfies only a `STANDARD`
 * requirement.
 */
export type WorkerAuthorityLevel = "STANDARD" | "ELEVATED";

const AUTHORITY_RANK: Readonly<Record<WorkerAuthorityLevel, number>> = {
  STANDARD: 0,
  ELEVATED: 1,
};

/**
 * §6 required semantics: "each worker has declared capabilities/tools/
 * policy constraints/evaluation evidence." `evaluationEvidenceRef` is an
 * opaque pointer to that evidence - this module never reads or
 * reinterprets it, only requires it to be present (a worker with no
 * evidence pointer cannot be admitted-and-routable). `declaredToolRefs` and
 * `declaredPolicyConstraintRefs` are opaque pointers too (e.g. to a tool
 * grant or a privacy/security certification) - this module never
 * interprets what they mean, only whether a worker declares every one a
 * route requires. `costWeight` is a caller-supplied, opaque relative-cost
 * figure used only for the ORDER a caller presents candidates in - it
 * plays no role in the eligibility filter itself, which is what proves
 * §6's "cost optimization cannot bypass policy."
 */
export interface AdmittedWorker {
  readonly workerId: string;
  readonly declaredCapabilityRefs: ReadonlyArray<string>;
  readonly declaredToolRefs: ReadonlyArray<string>;
  readonly declaredPolicyConstraintRefs: ReadonlyArray<string>;
  readonly trustStatus: WorkerTrustStatus;
  readonly availability: WorkerAvailability;
  readonly maxRiskLevel: WorkerRiskLevel;
  readonly authorityLevel: WorkerAuthorityLevel;
  readonly costWeight: number;
  readonly evaluationEvidenceRef: string;
}

export type WorkerRoutingDecisionStatus = "ROUTED" | "REJECTED";

/**
 * §6 acceptance: "routing decisions retain reason/provenance for material
 * work." `reason` is always populated, for both `ROUTED` and `REJECTED`
 * outcomes - a caller can never observe a routing decision with no
 * explanation of why it was made.
 */
export interface WorkerRoutingDecision {
  readonly requiredCapabilityRef: string;
  readonly riskLevel: WorkerRiskLevel;
  readonly status: WorkerRoutingDecisionStatus;
  readonly executorWorkerId?: string;
  readonly reviewerWorkerId?: string;
  readonly reason: string;
}

export interface WorkerRoutingRequest {
  readonly requiredCapabilityRef: string;
  readonly riskLevel: WorkerRiskLevel;
  /**
   * Required tool-access pointers and policy/privacy/security constraint
   * pointers for this route. Both are explicit, caller-declared arrays
   * (possibly empty when a route genuinely requires none) - a worker
   * missing even one required entry can never be selected, and no
   * fallback candidate can be selected on a relaxed subset of these.
   */
  readonly requiredToolRefs: ReadonlyArray<string>;
  readonly requiredPolicyConstraintRefs: ReadonlyArray<string>;
  readonly requiredAuthorityLevel: WorkerAuthorityLevel;
  readonly requiresIndependentReview: boolean;
  /**
   * Caller-supplied candidate order (e.g. cost-ascending). The eligibility
   * filter below is applied identically regardless of this order - a
   * cheaper, earlier-listed but ineligible worker is never selected ahead
   * of a later, eligible one.
   */
  readonly executorCandidates: ReadonlyArray<AdmittedWorker>;
  /**
   * Required only when `requiresIndependentReview` is true or
   * `riskLevel` is `HIGH_RISK`. Reviewer eligibility uses the same
   * policy filter as executor eligibility, plus the independence
   * constraint below.
   */
  readonly reviewerCandidates?: ReadonlyArray<AdmittedWorker>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidWorkerRoutingRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

function includesAll(declared: ReadonlyArray<string>, required: ReadonlyArray<string>): boolean {
  return required.every((ref) => declared.includes(ref));
}

function isEligible(
  worker: AdmittedWorker,
  requiredCapabilityRef: string,
  riskLevel: WorkerRiskLevel,
  requiredToolRefs: ReadonlyArray<string>,
  requiredPolicyConstraintRefs: ReadonlyArray<string>,
  requiredAuthorityLevel: WorkerAuthorityLevel,
): boolean {
  if (worker.trustStatus !== "ADMITTED") {
    return false;
  }
  if (worker.availability !== "AVAILABLE") {
    return false;
  }
  if (!worker.declaredCapabilityRefs.includes(requiredCapabilityRef)) {
    return false;
  }
  if (
    typeof worker.evaluationEvidenceRef !== "string" ||
    worker.evaluationEvidenceRef.trim().length === 0
  ) {
    return false;
  }
  if (riskLevel === "HIGH_RISK" && worker.maxRiskLevel !== "HIGH_RISK") {
    return false;
  }
  if (!includesAll(worker.declaredToolRefs, requiredToolRefs)) {
    return false;
  }
  if (!includesAll(worker.declaredPolicyConstraintRefs, requiredPolicyConstraintRefs)) {
    return false;
  }
  if (AUTHORITY_RANK[worker.authorityLevel] < AUTHORITY_RANK[requiredAuthorityLevel]) {
    return false;
  }
  return true;
}

function selectFirstEligible(
  candidates: ReadonlyArray<AdmittedWorker>,
  requiredCapabilityRef: string,
  riskLevel: WorkerRiskLevel,
  requiredToolRefs: ReadonlyArray<string>,
  requiredPolicyConstraintRefs: ReadonlyArray<string>,
  requiredAuthorityLevel: WorkerAuthorityLevel,
  excludeWorkerId?: string,
): AdmittedWorker | undefined {
  for (const candidate of candidates) {
    if (excludeWorkerId !== undefined && candidate.workerId === excludeWorkerId) {
      continue;
    }
    if (
      isEligible(
        candidate,
        requiredCapabilityRef,
        riskLevel,
        requiredToolRefs,
        requiredPolicyConstraintRefs,
        requiredAuthorityLevel,
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Resolves a §6-governed worker/model routing decision. Pure function -
 * never calls a real provider/model API, never reads the system clock,
 * never persists anything (§6: "provider-specific memory is never
 * canonical company memory" - this module carries no memory at all).
 *
 * Fails closed (throws `InvalidWorkerRoutingRequestError`) only on
 * malformed structural input (empty `requiredCapabilityRef`, invalid
 * `riskLevel`/`requiredAuthorityLevel`, or `requiresIndependentReview`/
 * `riskLevel: "HIGH_RISK"` with no `reviewerCandidates` supplied at all).
 * A policy outcome that fails to find an eligible worker is never a thrown
 * error - it is an explicit `REJECTED` decision with a reason, so
 * "provider outage degrades gracefully" (§6) rather than crashing the
 * caller.
 *
 * Executor selection: the first candidate in `executorCandidates` that is
 * `ADMITTED`, `AVAILABLE`, declares `requiredCapabilityRef`, carries a
 * non-empty `evaluationEvidenceRef`, declares every `requiredToolRef` and
 * `requiredPolicyConstraintRef`, has an `authorityLevel` at least
 * `requiredAuthorityLevel`, and (for `HIGH_RISK` work) has
 * `maxRiskLevel: "HIGH_RISK"`. Candidate order is caller-supplied
 * preference (e.g. cost-ascending) - it has no effect on eligibility, so
 * an ineligible-but-cheaper worker earlier in the list is never chosen
 * over an eligible one later in it (§6: "cost optimization cannot bypass
 * policy"), and a fallback candidate is held to the exact same tool/
 * policy/authority bar as the primary - fallback never routes on a
 * relaxed requirement set.
 *
 * Reviewer selection (only when `requiresIndependentReview` or
 * `riskLevel === "HIGH_RISK"`): the first `reviewerCandidates` entry that
 * passes the same eligibility filter AND is not the selected executor
 * (§6: "reviewer independence preserved where required" - an executor can
 * never review its own work through this function). No eligible,
 * independent reviewer found -> `REJECTED`, even if an executor was
 * otherwise eligible.
 */
export function resolveWorkerRoute(request: WorkerRoutingRequest): WorkerRoutingDecision {
  const requiredCapabilityRef = requireNonEmptyString(
    request.requiredCapabilityRef,
    "requiredCapabilityRef",
  );
  if (request.riskLevel !== "STANDARD" && request.riskLevel !== "HIGH_RISK") {
    throw new InvalidWorkerRoutingRequestError('riskLevel must be "STANDARD" or "HIGH_RISK"');
  }
  if (request.requiredAuthorityLevel !== "STANDARD" && request.requiredAuthorityLevel !== "ELEVATED") {
    throw new InvalidWorkerRoutingRequestError(
      'requiredAuthorityLevel must be "STANDARD" or "ELEVATED"',
    );
  }
  if (!Array.isArray(request.requiredToolRefs) || !Array.isArray(request.requiredPolicyConstraintRefs)) {
    throw new InvalidWorkerRoutingRequestError(
      "requiredToolRefs and requiredPolicyConstraintRefs must both be arrays (an empty array is valid when none are required)",
    );
  }
  const needsIndependentReview = request.requiresIndependentReview || request.riskLevel === "HIGH_RISK";
  if (needsIndependentReview && request.reviewerCandidates === undefined) {
    throw new InvalidWorkerRoutingRequestError(
      "reviewerCandidates is required when requiresIndependentReview is true or riskLevel is HIGH_RISK",
    );
  }

  const executor = selectFirstEligible(
    request.executorCandidates,
    requiredCapabilityRef,
    request.riskLevel,
    request.requiredToolRefs,
    request.requiredPolicyConstraintRefs,
    request.requiredAuthorityLevel,
  );
  if (executor === undefined) {
    return {
      requiredCapabilityRef,
      riskLevel: request.riskLevel,
      status: "REJECTED",
      reason:
        "no admitted, available worker declares the required capability, tools, policy constraints, and authority level at the required risk level",
    };
  }

  if (!needsIndependentReview) {
    return {
      requiredCapabilityRef,
      riskLevel: request.riskLevel,
      status: "ROUTED",
      executorWorkerId: executor.workerId,
      reason: `worker ${executor.workerId} is ADMITTED, AVAILABLE, declares ${requiredCapabilityRef} plus every required tool/policy constraint, meets the required authority level, and is authorized for ${request.riskLevel} risk; independent review not required for this route`,
    };
  }

  const reviewer = selectFirstEligible(
    request.reviewerCandidates as ReadonlyArray<AdmittedWorker>,
    requiredCapabilityRef,
    request.riskLevel,
    request.requiredToolRefs,
    request.requiredPolicyConstraintRefs,
    request.requiredAuthorityLevel,
    executor.workerId,
  );
  if (reviewer === undefined) {
    return {
      requiredCapabilityRef,
      riskLevel: request.riskLevel,
      status: "REJECTED",
      reason:
        "an eligible executor was found, but no eligible reviewer independent of that executor exists; an executor cannot review its own work",
    };
  }

  return {
    requiredCapabilityRef,
    riskLevel: request.riskLevel,
    status: "ROUTED",
    executorWorkerId: executor.workerId,
    reviewerWorkerId: reviewer.workerId,
    reason: `worker ${executor.workerId} is authorized as executor and worker ${reviewer.workerId} is authorized as an independent reviewer, both meeting every required capability/tool/policy/authority constraint at ${request.riskLevel} risk`,
  };
}
