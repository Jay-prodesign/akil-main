import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import { transitionOutcomeJob, type OutcomeJob } from "./outcome-job.js";
import type { WorkerRoutingDecision } from "./worker-routing-policy.js";
import { requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";

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
 * `outcome-job.ts` itself is untouched.
 *
 * Brain Rev114/115/116 correction (superseding the original reasoning
 * that used to appear in this comment): narrowing
 * `authorizedTransitionOutcomeJob` itself to reject `EXECUTING`
 * unconditionally, the way the Family-12 closure-gate correction
 * narrowed it for `CLOSED`, was deliberately NOT done here at first,
 * reasoning that no equivalent empirically-demonstrated bypass existed
 * yet and that `authorizedTransitionOutcomeJob` is exercised for
 * `EXECUTING` throughout this repository's own existing, already
 * Brain-reviewed test suites (e.g. every `jobAtVerifying`-style helper)
 * as ordinary, non-routed staff-initiated work. Brain's review found
 * this incomplete: leaving `EXECUTING` universally open meant a
 * routing-required Family-12/Cold-Start job could bypass
 * `RoutedExecutionAssignment` entirely through the same ordinary path -
 * structurally identical to the `CLOSED` bypass, just for a job whose
 * own admitted policy actually requires routing. The corrected
 * disposition (see `ExecutionRoutingRequirement` below and
 * `authorized-outcome-job-operations.ts`'s own updated doc comment) is
 * neither "always open" nor "always narrowed": `EXECUTING` now requires
 * an explicit, scope-bound `ExecutionRoutingRequirement` for every
 * caller, and only a `ROUTING_REQUIRED` classification forces the
 * dedicated routed path - `MANUAL_EXECUTION_ALLOWED` preserves the
 * legitimate non-routed path exactly as before, so existing
 * Brain-reviewed callers are not retroactively broken, only required to
 * state which kind of job they hold.
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

export class InvalidExecutionRoutingRequirementError extends Error {
  constructor(reason: string) {
    super(`Invalid ExecutionRoutingRequirement: ${reason}`);
    this.name = "InvalidExecutionRoutingRequirementError";
  }
}

/**
 * Brain Rev114/115/116 (independent exact-head review of this checkpoint):
 * the reasoning above for why `authorizedTransitionOutcomeJob`'s ordinary
 * `EXECUTING` path is left open was correct for the *general* case
 * (non-routed staff-initiated work genuinely exists and must keep
 * working), but incomplete: it left every `EXECUTING` transition -
 * including jobs whose own admitted policy actually requires routing -
 * reachable through that same ordinary path with no way to tell the two
 * apart at the enforcement boundary. A routing-required Family-12/
 * Cold-Start job could still bypass `RoutedExecutionAssignment` entirely
 * by calling the plain `authorizedTransitionOutcomeJob(job, "EXECUTING")`
 * - structurally the same opt-in/bypass class Rev111 already found (and
 * fixed) for approval -> closure.
 *
 * Brain Rev117 then found the first fix (a freely caller-constructible
 * `ExecutionRoutingRequirement`, gated only by `requireProtectedActionAuthorization`
 * on the `MANUAL_EXECUTION_ALLOWED` branch) was still insufficient: a
 * protected-authority holder - not just an ordinary WRITE-level caller -
 * could construct `MANUAL_EXECUTION_ALLOWED` fresh, per call, for any
 * job, including one whose real admitted policy is `ROUTING_REQUIRED`.
 * Protected-action authority proves the caller may make protected
 * decisions in general; it does not prove the admitted execution policy
 * for *this specific job* is manual. Rev118's own framing: "this is
 * materially different from `ClosureApprovalReference`, where the caller
 * label does not itself choose whether the gate applies" - here the
 * label WAS the gate.
 *
 * Brain Rev118/119's required correction: source/persist the policy from
 * an already-authoritative admission fact *before* execution authority is
 * ever exercised, so the execution-time caller can only ever *consume* an
 * already-admitted fact, never *choose* one. `ExecutionRoutingRequirementRegistry`
 * is that persistence boundary: `admit` is a one-time, immutable-once-set
 * write (mirroring `FileDurableOutcomeJobStore`'s own put-if-absent
 * discipline for `OutcomeJob` itself, and `ClosureApprovalReference`'s own
 * "protected authority is required to construct the weaker/opening
 * classification" pattern) - re-admitting the *same* policy for a job is
 * a harmless no-op, but attempting to admit a *different* policy for an
 * already-admitted job throws `ExecutionRoutingRequirementAlreadyAdmittedError`
 * unconditionally, regardless of the second caller's own authority level.
 * `lookup` is the only way `authorizedTransitionOutcomeJob`'s `EXECUTING`
 * gate consumes a requirement now - there is no execution-time
 * "construct and pass" path left at all, so an execution caller (ordinary
 * or protected) cannot manufacture, nor retroactively change, the
 * classification for a job that was already admitted as `ROUTING_REQUIRED`.
 *
 * `ROUTING_REQUIRED` still needs no elevated authority to admit (it only
 * ever tightens the gate); `MANUAL_EXECUTION_ALLOWED` still requires
 * `requireProtectedActionAuthorization` to admit, exactly as Rev117
 * established - the difference is *when* that authority is exercised
 * (once, at admission, immutably) rather than freely at every execution
 * attempt.
 *
 * Honest limit carried forward unchanged from Rev117/Rev111 F2: this does
 * not claim to independently re-derive which jobs truly require routing,
 * nor does it yet wire automatic admission from `service-catalog-admission.ts`/
 * `commercial-order.ts`/plan-admission into this registry (Brain's own
 * "reuse the existing trusted service/catalog admission ... where
 * semantically valid" note names that as the eventual real source of
 * truth) - that composition is a separate, later, explicitly deferred
 * integration step, not fabricated here. What this checkpoint closes is
 * the structural vulnerability: whoever admits a job's routing
 * requirement and whoever executes it are no longer required to be
 * indistinguishable, because admission is a one-time mutation and
 * execution is read-only consumption of it.
 */
export type ExecutionRoutingPolicy = "ROUTING_REQUIRED" | "MANUAL_EXECUTION_ALLOWED";

export interface ExecutionRoutingRequirement {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly policy: ExecutionRoutingPolicy;
  readonly admittedAt: string;
}

export class ExecutionRoutingRequirementAlreadyAdmittedError extends Error {
  constructor(jobId: OutcomeJob["jobId"], existingPolicy: ExecutionRoutingPolicy, attemptedPolicy: ExecutionRoutingPolicy) {
    super(
      `ExecutionRoutingRequirement for OutcomeJob ${jobId} was already admitted as ${existingPolicy}; cannot re-admit as ${attemptedPolicy} - the routing requirement is immutable once admitted`,
    );
    this.name = "ExecutionRoutingRequirementAlreadyAdmittedError";
  }
}

function requireNonEmptyExecutionRoutingField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidExecutionRoutingRequirementError(`${field} must be a non-empty string`);
  }
  return value;
}

function executionRoutingRequirementKey(scope: {
  tenantId: TenantScope["tenantId"];
  customerId: Customer["customerId"];
  projectId: Project["projectId"];
  jobId: OutcomeJob["jobId"];
}): string {
  return `${scope.tenantId}::${scope.customerId}::${scope.projectId}::${scope.jobId}`;
}

/**
 * `admit` is the only way to produce an `ExecutionRoutingRequirement` -
 * there is no other exported constructor. Called once, at admission
 * time, structurally separate from whatever later calls
 * `authorizedTransitionOutcomeJob(..., "EXECUTING")`. `lookup` never
 * mutates and never accepts a caller-supplied classification.
 */
export interface ExecutionRoutingRequirementRegistry {
  admit(input: {
    job: OutcomeJob;
    policy: ExecutionRoutingPolicy;
    authority: AuthorityContext;
    admittedAt: unknown;
  }): ExecutionRoutingRequirement;
  lookup(job: OutcomeJob): ExecutionRoutingRequirement | undefined;
}

export function createExecutionRoutingRequirementRegistry(): ExecutionRoutingRequirementRegistry {
  const admitted = new Map<string, ExecutionRoutingRequirement>();
  return {
    admit(input) {
      if (input.policy !== "ROUTING_REQUIRED" && input.policy !== "MANUAL_EXECUTION_ALLOWED") {
        throw new InvalidExecutionRoutingRequirementError(
          `policy must be "ROUTING_REQUIRED" or "MANUAL_EXECUTION_ALLOWED"; got ${JSON.stringify(input.policy)}`,
        );
      }
      if (input.policy === "MANUAL_EXECUTION_ALLOWED") {
        requireProtectedActionAuthorization(input.authority, "admitExecutionRoutingRequirement:MANUAL_EXECUTION_ALLOWED");
      }
      const key = executionRoutingRequirementKey(input.job);
      const existing = admitted.get(key);
      if (existing !== undefined) {
        if (existing.policy !== input.policy) {
          throw new ExecutionRoutingRequirementAlreadyAdmittedError(input.job.jobId, existing.policy, input.policy);
        }
        return existing;
      }
      const requirement: ExecutionRoutingRequirement = {
        tenantId: input.job.tenantId,
        customerId: input.job.customerId,
        projectId: input.job.projectId,
        jobId: input.job.jobId,
        policy: input.policy,
        admittedAt: requireNonEmptyExecutionRoutingField(input.admittedAt, "admittedAt"),
      };
      admitted.set(key, requirement);
      return requirement;
    },
    lookup(job) {
      return admitted.get(executionRoutingRequirementKey(job));
    },
  };
}
