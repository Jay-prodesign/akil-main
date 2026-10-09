import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import { transitionOutcomeJob, type OutcomeJob } from "./outcome-job.js";
import type { WorkerRoutingDecision } from "./worker-routing-policy.js";

export class InvalidRoutedExecutionAssignmentError extends Error {
  constructor(reason: string) {
    super(`Invalid RoutedExecutionAssignment: ${reason}`);
    this.name = "InvalidRoutedExecutionAssignmentError";
  }
}

export class OutcomeJobExecutionNotRoutedError extends Error {
  constructor(jobId: OutcomeJob["jobId"]) {
    super(`OutcomeJob ${jobId} cannot begin execution: no valid RoutedExecutionAssignment was supplied for it`);
    this.name = "OutcomeJobExecutionNotRoutedError";
  }
}

/**
 * Rev98 Family 12's own named chain segment: "... dynamic work plan ->
 * admitted routing -> authorized execution -> QA/evidence ..." A fresh
 * repo-wide audit (PR #58's own FAMILY-12-CLOSURE-APPROVAL-GATE exec-plan)
 * found this exact pair of segments are disjoint islands: `worker-routing-
 * policy.ts`'s `resolveWorkerRoute` produces a `WorkerRoutingDecision`
 * naming an `executorWorkerId` for an abstract `requiredCapabilityRef`,
 * but carries no `OutcomeJob` identity at all - and `outcome-job.ts`'s own
 * `MAIN_PATH_TRANSITIONS` lets any caller move a `READY` job straight to
 * `EXECUTING` via the generic `transitionOutcomeJob`, with no routing
 * decision required or even representable at that call site. A job can
 * begin executing without ever having gone through admitted routing at
 * all, and a routing decision has nothing that binds it to the specific
 * job whose execution it was meant to authorize.
 *
 * This module closes that one gap only, mirroring exactly the same
 * purely-additive composition shape as `outcome-job-closure-approval.ts`:
 * a new `RoutedExecutionAssignment` binds a `ROUTED` `WorkerRoutingDecision`
 * to a specific job's own tenant/customer/project/job identity (the same
 * Rev62 AUD-V2-01 discipline every other scope-binding construct in this
 * repository follows), and `authorizeOutcomeJobExecutionFromRouting`
 * requires a valid, matching assignment before delegating the actual
 * transition entirely to the existing, unmodified `transitionOutcomeJob`.
 * `outcome-job.ts` itself is untouched - the existing bare
 * `transitionOutcomeJob(readyJob, "EXECUTING")` path remains available to
 * any caller who does not opt into this stricter, dedicated path, exactly
 * mirroring how `closeOutcomeJobWithApproval` and `verifyOutcomeJob` are
 * each stricter gates layered *next to* the generic transition table
 * rather than replacing it. Narrowing `authorizedTransitionOutcomeJob`
 * itself to reject `EXECUTING` (the way the Family-12 closure-gate
 * correction narrowed it for `CLOSED`) is deliberately NOT done here: PR
 * #58's own precedent for that narrowing was a real, empirically-
 * demonstrated bypass with zero legitimate existing callers of the
 * ordinary path for that exact transition; no equivalent audit finding
 * exists yet for `EXECUTING`, and `authorizedTransitionOutcomeJob` is
 * exercised for `EXECUTING` throughout this repository's own existing,
 * already Brain-reviewed test suites (e.g. every `jobAtVerifying`-style
 * helper) as ordinary, non-routed staff-initiated work. Retroactively
 * closing that path here would be an unreviewed, overreaching behavior
 * change to already-verified callers, not a bounded addition - exactly
 * the discipline this checkpoint's own governing `CLAUDE.md` forbids.
 *
 * `PartnerRoutingDecision` (`partner-routing-decision.ts`) is a distinct,
 * separately-scoped routing concept (external partner-organization
 * assignment, not `AdmittedWorker` selection) and is explicitly out of
 * scope for this checkpoint - it carries its own `targetOwnership`/
 * `decidedByOwnerId` shape with no job-execution semantics to bind here,
 * and inventing a shared binding would conflate two real, distinct
 * domain concepts rather than closing a genuine gap.
 */
export interface RoutedExecutionAssignment {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly requiredCapabilityRef: string;
  readonly executorWorkerId: string;
  readonly reviewerWorkerId?: string;
  readonly boundAt: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidRoutedExecutionAssignmentError(`${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new InvalidRoutedExecutionAssignmentError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidRoutedExecutionAssignmentError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * `job` and `decision` each supply their own real fields directly - no
 * separate caller-typed identifier for any of them - so an assignment can
 * never be constructed for a job or a routing decision the caller did not
 * actually have real values for. Fails closed unless `decision.status ===
 * "ROUTED"`: a `REJECTED` routing decision can never authorize execution,
 * no matter what job it is paired with. `resolveWorkerRoute` itself
 * already guarantees a `ROUTED` decision always carries a non-empty
 * `executorWorkerId` (never both `ROUTED` and executor-less), so this
 * function additionally fails closed if that invariant is ever violated
 * by a malformed/adversarial caller-constructed decision object, rather
 * than assuming it.
 */
export function createRoutedExecutionAssignment(input: {
  job: OutcomeJob;
  decision: WorkerRoutingDecision;
  boundAt: unknown;
}): RoutedExecutionAssignment {
  if (input.decision.status !== "ROUTED") {
    throw new InvalidRoutedExecutionAssignmentError(
      `decision.status must be "ROUTED"; got ${JSON.stringify(input.decision.status)}`,
    );
  }
  const executorWorkerId = requireNonEmptyString(input.decision.executorWorkerId, "decision.executorWorkerId");
  const boundAt = requireNonEmptyString(input.boundAt, "boundAt");
  const base = {
    tenantId: input.job.tenantId,
    customerId: input.job.customerId,
    projectId: input.job.projectId,
    jobId: input.job.jobId,
    requiredCapabilityRef: requireNonEmptyString(input.decision.requiredCapabilityRef, "decision.requiredCapabilityRef"),
    executorWorkerId,
    boundAt,
  };
  if (input.decision.reviewerWorkerId === undefined) {
    return base;
  }
  return {
    ...base,
    reviewerWorkerId: requireNonEmptyString(input.decision.reviewerWorkerId, "decision.reviewerWorkerId"),
  };
}

/**
 * Fail-closed on every scoping dimension, mirroring
 * `isClosureApprovalValidForJob`'s own discipline: an assignment bound
 * for one tenant/customer/project/job never silently validates a
 * different one, even if some individual fields happen to coincide.
 */
export function isRoutedExecutionAssignmentValidForJob(
  assignment: RoutedExecutionAssignment,
  job: OutcomeJob,
): boolean {
  return (
    assignment.tenantId === job.tenantId &&
    assignment.customerId === job.customerId &&
    assignment.projectId === job.projectId &&
    assignment.jobId === job.jobId
  );
}

/**
 * The routing-gated execution path: throws
 * `OutcomeJobExecutionNotRoutedError` rather than silently falling back
 * to the bare `transitionOutcomeJob(job, "EXECUTING")` when no valid
 * assignment is supplied - a `READY` job is never moved to `EXECUTING`
 * "by default" through this function. Delegates the actual state
 * transition entirely to the existing, unmodified `transitionOutcomeJob`,
 * so every one of its own invariants (job must currently be `READY`,
 * `EXECUTING` only accepts the one further `VERIFYING` edge) still
 * applies exactly as AKI-BE-001 specified - this function adds a
 * precondition, it does not re-implement or relax the state machine.
 */
export function authorizeOutcomeJobExecutionFromRouting(input: {
  job: OutcomeJob;
  assignment: RoutedExecutionAssignment | undefined;
}): OutcomeJob {
  if (input.assignment === undefined || !isRoutedExecutionAssignmentValidForJob(input.assignment, input.job)) {
    throw new OutcomeJobExecutionNotRoutedError(input.job.jobId);
  }
  return transitionOutcomeJob(input.job, "EXECUTING");
}
