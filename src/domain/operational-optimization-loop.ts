import type { WorkerRiskLevel } from "./worker-routing-policy.js";
import type { MetricReadModel, MetricReadModelStatus } from "./observability-telemetry.js";

export class InvalidOptimizationPolicyError extends Error {
  constructor(reason: string) {
    super(`Invalid OptimizationPolicy: ${reason}`);
    this.name = "InvalidOptimizationPolicyError";
  }
}

export class InvalidOptimizationCandidateActionError extends Error {
  constructor(reason: string) {
    super(`Invalid OptimizationCandidateAction: ${reason}`);
    this.name = "InvalidOptimizationCandidateActionError";
  }
}

/**
 * Rev98 Family 8 text: "bounded operational optimization loop, distinct
 * from V5-EVAL-001, with authority/risk/reversibility/policy/budget and
 * stop/escalate behavior." V5-EVAL-001's `governed-evaluation-loop.ts`
 * governs discrete, independently-reviewed *change proposals* to policy/
 * routing/prompts (propose -> classify -> test -> review -> adopt/reject);
 * this module instead governs one already-authorized policy's live,
 * per-action operational execution loop - a running worker deciding
 * whether to continue, stop, or escalate its *next* bounded action. Same
 * repository, deliberately non-overlapping lifecycle and subject matter.
 *
 * `CONTINUE` is the only decision that permits the candidate action to
 * proceed unaltered. `STOP` and `ESCALATE` are both refusals to proceed
 * automatically - `STOP` is a hard resource/budget limit with no path
 * forward except a new policy or authorization; `ESCALATE` hands the
 * decision to a human/higher-authority reviewer rather than silently
 * refusing or silently proceeding.
 */
export type OptimizationDecision = "CONTINUE" | "STOP" | "ESCALATE";

/**
 * Closed, non-fabricated reason codes - never free text - matching this
 * repository's established discipline of never inventing narrative
 * explanations a caller could mistake for evidence. Each reason maps to
 * exactly one structural check in `evaluateOptimizationCandidate`.
 */
export type OptimizationEscalationReason =
  | "TELEMETRY_UNAVAILABLE"
  | "TELEMETRY_STALE"
  | "RISK_EXCEEDS_POLICY"
  | "IRREVERSIBLE_ACTION_REQUIRES_REVIEW";

export type OptimizationStopReason = "BUDGET_EXHAUSTED";

const RISK_RANK: Readonly<Record<WorkerRiskLevel, number>> = {
  STANDARD: 0,
  HIGH_RISK: 1,
};

/**
 * The "authority" leg of Rev98's five named dimensions: a policy cannot
 * exist without a declared authorizing worker. This module never checks
 * that worker's own standing (that is `worker-routing-policy.ts`'s job) -
 * it only refuses to construct a policy with no authority binding at all,
 * so an optimization loop can never run under a policy nobody authorized.
 */
export interface OptimizationPolicy {
  readonly policyRef: string;
  readonly authorizedByWorkerId: string;
  readonly maxRiskLevel: WorkerRiskLevel;
  readonly budgetLimit: number;
  readonly reversibilityRequired: boolean;
}

function requireNonEmptyString(value: unknown, field: string, ErrorType: new (reason: string) => Error): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ErrorType(`${field} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(
  value: unknown,
  field: string,
  ErrorType: new (reason: string) => Error,
  options?: { allowZero?: boolean },
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ErrorType(`${field} must be a finite number`);
  }
  const minimum = options?.allowZero ? 0 : Number.EPSILON;
  if (value < minimum) {
    throw new ErrorType(`${field} must be ${options?.allowZero ? "zero or greater" : "greater than zero"}`);
  }
  return value;
}

function requireRiskLevel(value: unknown, field: string, ErrorType: new (reason: string) => Error): WorkerRiskLevel {
  if (value !== "STANDARD" && value !== "HIGH_RISK") {
    throw new ErrorType(`${field} must be "STANDARD" or "HIGH_RISK"`);
  }
  return value;
}

/**
 * The only construction path for an `OptimizationPolicy`. Accepts no
 * `decision`/outcome field - a policy is a bound of authority/risk/
 * reversibility/budget, never a pre-decided result.
 */
export function createOptimizationPolicy(input: {
  policyRef: unknown;
  authorizedByWorkerId: unknown;
  maxRiskLevel: unknown;
  budgetLimit: unknown;
  reversibilityRequired: unknown;
}): OptimizationPolicy {
  if (typeof input.reversibilityRequired !== "boolean") {
    throw new InvalidOptimizationPolicyError("reversibilityRequired must be a boolean");
  }
  return {
    policyRef: requireNonEmptyString(input.policyRef, "policyRef", InvalidOptimizationPolicyError),
    authorizedByWorkerId: requireNonEmptyString(
      input.authorizedByWorkerId,
      "authorizedByWorkerId",
      InvalidOptimizationPolicyError,
    ),
    maxRiskLevel: requireRiskLevel(input.maxRiskLevel, "maxRiskLevel", InvalidOptimizationPolicyError),
    budgetLimit: requireFiniteNumber(input.budgetLimit, "budgetLimit", InvalidOptimizationPolicyError),
    reversibilityRequired: input.reversibilityRequired,
  };
}

/**
 * One candidate next step of an already-running operational loop.
 * `telemetrySignal` is a caller-supplied, already-projected
 * `MetricReadModel` from `observability-telemetry.ts` - this module never
 * fetches or re-derives telemetry itself, only reads its `status`.
 */
export interface OptimizationCandidateAction {
  readonly actionRef: string;
  readonly riskLevel: WorkerRiskLevel;
  readonly reversible: boolean;
  readonly estimatedCost: number;
  readonly telemetrySignal: MetricReadModel;
}

/**
 * The only construction path for an `OptimizationCandidateAction`.
 */
export function createOptimizationCandidateAction(input: {
  actionRef: unknown;
  riskLevel: unknown;
  reversible: unknown;
  estimatedCost: unknown;
  telemetrySignal: MetricReadModel;
}): OptimizationCandidateAction {
  if (typeof input.reversible !== "boolean") {
    throw new InvalidOptimizationCandidateActionError("reversible must be a boolean");
  }
  return {
    actionRef: requireNonEmptyString(input.actionRef, "actionRef", InvalidOptimizationCandidateActionError),
    riskLevel: requireRiskLevel(input.riskLevel, "riskLevel", InvalidOptimizationCandidateActionError),
    reversible: input.reversible,
    estimatedCost: requireFiniteNumber(input.estimatedCost, "estimatedCost", InvalidOptimizationCandidateActionError, {
      allowZero: true,
    }),
    telemetrySignal: input.telemetrySignal,
  };
}

export interface OptimizationEvaluation {
  readonly actionRef: string;
  readonly decision: OptimizationDecision;
  readonly escalationReason?: OptimizationEscalationReason;
  readonly stopReason?: OptimizationStopReason;
}

/**
 * §Family-8 acceptance, all structurally enforced, evaluated in this
 * fixed order:
 *
 * 1. Telemetry honesty (reuses the exact absence-is-not-positive-evidence
 *    discipline already established in `cross-surface-evidence-
 *    convergence.ts`/Family 7): a `MISSING`/`NOT_MONITORED` signal can
 *    never be silently treated as safe-to-continue, and a `REPORTED_STALE`
 *    signal is never trusted as current. Both escalate rather than guess.
 * 2. Risk vs. policy: a candidate whose `riskLevel` exceeds the policy's
 *    `maxRiskLevel` always escalates, regardless of cost or budget
 *    remaining - a cheap high-risk action is not a safe high-risk action.
 * 3. Reversibility: when the policy requires reversibility, a non-
 *    reversible candidate always escalates, regardless of risk tier.
 * 4. Budget: only once telemetry/risk/reversibility have all cleared does
 *    running cost matter. Exceeding `budgetLimit` stops the loop outright
 *    - budget is a hard resource ceiling, not something a reviewer can
 *    wave through the way an escalation can.
 *
 * `CONTINUE` is returned only when every check above clears - it is never
 * the default; every earlier `return`/branch is a refusal.
 */
export function evaluateOptimizationCandidate(input: {
  policy: OptimizationPolicy;
  candidate: OptimizationCandidateAction;
  spentSoFar: unknown;
}): OptimizationEvaluation {
  const spentSoFar = requireFiniteNumber(
    input.spentSoFar,
    "spentSoFar",
    InvalidOptimizationCandidateActionError,
    { allowZero: true },
  );
  const { policy, candidate } = input;

  const telemetryStatus: MetricReadModelStatus = candidate.telemetrySignal.status;
  if (telemetryStatus === "MISSING" || telemetryStatus === "NOT_MONITORED") {
    return { actionRef: candidate.actionRef, decision: "ESCALATE", escalationReason: "TELEMETRY_UNAVAILABLE" };
  }
  if (telemetryStatus === "REPORTED_STALE") {
    return { actionRef: candidate.actionRef, decision: "ESCALATE", escalationReason: "TELEMETRY_STALE" };
  }

  if (RISK_RANK[candidate.riskLevel] > RISK_RANK[policy.maxRiskLevel]) {
    return { actionRef: candidate.actionRef, decision: "ESCALATE", escalationReason: "RISK_EXCEEDS_POLICY" };
  }

  if (policy.reversibilityRequired && !candidate.reversible) {
    return {
      actionRef: candidate.actionRef,
      decision: "ESCALATE",
      escalationReason: "IRREVERSIBLE_ACTION_REQUIRES_REVIEW",
    };
  }

  if (spentSoFar + candidate.estimatedCost > policy.budgetLimit) {
    return { actionRef: candidate.actionRef, decision: "STOP", stopReason: "BUDGET_EXHAUSTED" };
  }

  return { actionRef: candidate.actionRef, decision: "CONTINUE" };
}
