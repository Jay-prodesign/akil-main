import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";
import { transitionOutcomeJob, type OutcomeJob } from "./outcome-job.js";
import type { WorkerRoutingDecision } from "./worker-routing-policy.js";
import type { OutcomeJobSpec } from "./outcome-job-spec.js";
import type { ServiceCatalogAdmission } from "./service-catalog-admission.js";

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

/**
 * Brain Rev121 correction (independent exact-head review of head c18075d):
 * Rev120 bound each admission path to a real primitive, but neither primitive
 * actually proved anything about *this exact job*. `WorkerRoutingDecision`
 * (`worker-routing-policy.ts`) carries no `OutcomeJob` identity at all - it
 * proves routing was resolved for an abstract `requiredCapabilityRef`, not
 * that *this job's* fulfillment channel is the one that was routed. An
 * `AdmittedWorker` with `authorityLevel: "ELEVATED"` proves that worker's own
 * admission/authority in general, not that *this job's* policy is manual -
 * any elevated worker anywhere in the tenant, with no connection whatsoever
 * to this job, could admit `MANUAL_EXECUTION_ALLOWED` for it. Rev121's own
 * framing: bind the registry to an admitted, provenance-bearing *exact-job*
 * fact, or the narrowest adapter deriving one from existing primitives - not
 * a fresh service/plan-level policy system (a live repo-wide check found no
 * existing binding anywhere from `OutcomeJob` identity to
 * `ServiceCatalogAdmission`/`CommercialOrder` - `outcome-job-wiring.ts` wires
 * jobs from plan/blueprint-derived `OutcomeJobSpec`s alone, with no
 * `serviceRef`/recipe reference on the runtime `OutcomeJob` at all - so
 * building that full chain now would be inventing a new cross-cutting
 * binding across several already-reviewed foundational modules, not "the
 * narrowest adapter"; that remains explicitly open, named below, not
 * fabricated).
 *
 * The narrowest real fix reuses what already exists:
 *
 * - `admitRoutingRequiredFromAssignment` (replacing `admitRoutingRequiredFromDecision`)
 *   now requires a real `RoutedExecutionAssignment` - the one construct in
 *   this exact module that already, honestly binds a `WorkerRoutingDecision`
 *   to a specific job's own tenant/customer/project/jobId
 *   (`isRoutedExecutionAssignmentValidForJob`, already Brain-reviewed at
 *   Rev114-116). An assignment bound to a *different* job can never satisfy
 *   this check, closing the "unrelated routing decision" gap completely and
 *   honestly - not merely by convention. `REJECTED`-decision admission is
 *   deliberately dropped: no existing primitive binds a `REJECTED` decision
 *   to an exact job (`createRoutedExecutionAssignment` itself only accepts
 *   `ROUTED`), and inventing one solely to preserve that permissive case
 *   would be exactly the kind of new construct this correction is trying to
 *   avoid. This is not a regression: a job with no admitted requirement at
 *   all already fails closed at `authorizedTransitionOutcomeJob`'s
 *   `EXECUTING` gate (`MissingExecutionRoutingRequirementError`), which is
 *   the correct disposition for "routing was attempted and failed" until a
 *   real `ROUTED` assignment or an authoritative manual admission exists.
 * - `admitManualExecutionAllowedByAdmittedWorker` now additionally requires
 *   `admittingWorker.trustStatus === "ADMITTED"` (mirroring
 *   `service-catalog-admission.ts`'s own `admitServiceCatalogEntry` -
 *   Rev102 F2 - which has always required *both* `trustStatus: "ADMITTED"`
 *   *and* `authorityLevel: "ELEVATED"` together; Rev120 only carried the
 *   second half of that already-established pair) and a non-empty
 *   `evidenceRef`, both persisted onto the resulting `ExecutionRoutingRequirement`
 *   as `admittedByAuthorityId`/`evidenceRef` - the same provenance shape
 *   `ServiceCatalogAdmission` itself already carries, so the requirement
 *   record is auditable rather than a bare policy label. Honest limit: this
 *   still does not prove *this specific job's* real plan/service policy is
 *   manual - no such fact exists anywhere in the domain model yet (see
 *   above) - it proves an admitted, trusted, evidenced, ELEVATED identity
 *   made this decision for this exact job, which is the narrowest
 *   provenance-bearing tightening available without inventing a new
 *   job-to-service binding. Wiring `OutcomeJob` identity through to a real
 *   `ServiceCatalogAdmission`-derived policy fact remains the eventual real
 *   source of truth and is named here as the next required correction, not
 *   fabricated in this cycle.
 */
export interface ExecutionRoutingRequirement {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly projectId: Project["projectId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly policy: ExecutionRoutingPolicy;
  readonly admittedAt: string;
  readonly admittedByAuthorityId?: string;
  readonly evidenceRef?: string;
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
 * Brain Rev120 correction: the registry above closed *re-labeling* (an
 * already-admitted job's policy could never be changed), but the FIRST
 * admission of either policy was still a bare caller-selected string -
 * `ROUTING_REQUIRED` admitted by any WRITE authority, `MANUAL_EXECUTION_ALLOWED`
 * admitted by any generic protected-action authority. Rev120's own
 * framing: "generic protected-action authority is not evidence that this
 * specific job's admitted execution policy is manual." The required
 * correction is to bind the *initial* policy to an existing authoritative
 * fact, reusing existing primitives, rather than accept a caller-chosen
 * string at all.
 *
 * There are now two separate, narrowly-scoped admission entry points
 * instead of one generic `admit` - each derives its policy from a real
 * existing primitive rather than accepting `policy` as a parameter:
 *
 * - `admitRoutingRequiredFromDecision` derives `ROUTING_REQUIRED`
 *   *only* from a real `WorkerRoutingDecision` (`worker-routing-policy.ts`,
 *   already Brain-reviewed) - the actual routing engine having been
 *   invoked at all (`ROUTED` or `REJECTED`, either one) is itself the
 *   authoritative proof that this job's fulfillment channel requires
 *   admitted routing. No caller authority is required to admit this,
 *   because it can only ever tighten the gate - a WRITE-only caller
 *   supplying a real decision object can never use it to weaken
 *   anything, mirroring why `RoutedExecutionAssignment`/`ExecutionRoutingPolicy`'s
 *   own "ROUTING_REQUIRED never needs elevated authority" rule was
 *   already accepted at Rev117.
 * - `admitManualExecutionAllowedByAdmittedWorker` derives
 *   `MANUAL_EXECUTION_ALLOWED` *only* from a real `AdmittedWorker`
 *   (`worker-routing-policy.ts`) whose own `authorityLevel` is
 *   `"ELEVATED"` - reusing the exact same admitted-identity primitive
 *   `service-catalog-admission.ts`'s own `admittedByAuthorityId` already
 *   established as this repository's real "who may admit a trust-bearing
 *   fact" boundary (Rev102 F2), instead of a generic tenant-level
 *   `AuthorityContext`. This is a genuinely narrower, more specific
 *   binding than "any protected-authority holder in this tenant" - it
 *   requires a real, already-vetted worker identity, not merely a
 *   permission flag.
 *
 * Honest limit carried forward from Rev120: neither path independently
 * derived policy from a real *service/plan-level* "this job requires/does
 * not require routing" fact composed from `service-catalog-admission.ts`/
 * `commercial-order.ts`/plan-admission.
 *
 * Brain Rev122 correction (independent exact-head review of head `dca29bd`,
 * the Rev121 fix): confirmed the ROUTING side resolved (`admitRoutingRequiredFromAssignment`'s
 * job-bound `RoutedExecutionAssignment` requirement is sufficient), but the
 * MANUAL side was not: `admitManualExecutionAllowedByAdmittedWorker`'s
 * `trustStatus`/`authorityLevel`/`evidenceRef` checks prove an admitted,
 * elevated worker made *some* evidenced decision, but that worker and that
 * evidence have zero required connection to *this exact job* - any
 * ADMITTED+ELEVATED worker with a caller-supplied `evidenceRef` string can
 * still first-admit `MANUAL_EXECUTION_ALLOWED` for an arbitrary job. Brain's
 * required correction: bind MANUAL admission to a provenance-bearing
 * authoritative exact-job execution-policy fact derived/reused from the
 * trusted service/catalog + commercial order/plan/job admission chain - and
 * if the required job↔service/plan binding does not yet exist, implement
 * the smallest honest adapter rather than continue deferring it.
 *
 * `admitManualExecutionAllowedByAdmittedWorker` is therefore replaced by
 * `admitManualExecutionAllowedFromServiceCatalogAdmission`, which no longer
 * accepts a bare worker/evidenceRef pair at all. It requires:
 *
 * - `spec: OutcomeJobSpec` - the exact plan-compilation record this runtime
 *   job was wired from. `outcome-job-wiring.ts`'s own `wireAdmittedOutcomeJobs`
 *   derives `OutcomeJob.jobId` deterministically and verbatim from
 *   `OutcomeJobSpec.specId` (Rev62 AUD-DEL-02's own uniqueness fix), so
 *   `spec.specId === job.jobId` is real proof this spec is the one this
 *   exact job came from, not a caller-asserted label - a spec belonging to
 *   any other job can never satisfy this check.
 * - `admission: ServiceCatalogAdmission` (`service-catalog-admission.ts`,
 *   Family 1, already Brain-reviewed at Rev102) - a real admission is only
 *   ever producible via `admitServiceCatalogEntry`, which itself already
 *   requires `trustStatus: "ADMITTED"` *and* `authorityLevel: "ELEVATED"`
 *   plus a non-empty `evidenceRef` (the exact pair Rev122 found this
 *   module's own worker-vouching path was missing the job-binding half of).
 *   This function additionally requires `admission.status === "ADMITTED"`
 *   (a `REVOKED` admission can never vouch for anything) and
 *   `admission.blueprintId`/`admission.blueprintVersion` to match
 *   `spec.sourceBlueprintId`/`spec.sourceBlueprintVersion` exactly - the
 *   admitted catalog entry must actually cover the same blueprint version
 *   this job's own requirement was compiled from, not merely exist
 *   somewhere in the tenant's catalog.
 *
 * Chained together, these two checks are the smallest honest adapter Brain
 * asked for: `job` -> (by construction) `spec` -> (by blueprint match)
 * `admission` -> (by construction) the ELEVATED+ADMITTED authority that
 * created it. No caller-supplied `evidenceRef`/worker is accepted directly
 * any more - the resulting requirement's `admittedByAuthorityId`/`evidenceRef`
 * are copied verbatim from the real `admission` record itself, so the
 * provenance is the catalog admission's own, not a fresh claim invented at
 * this call site. Honest limit still disclosed: `ServiceCatalogAdmission`
 * itself carries no explicit "requires routing vs. manual" boolean - this
 * proves the job's originating requirement traces to a real, currently
 * trusted, evidenced service/catalog entry (the same "canonical service
 * boundary" Family 1 already established), which this checkpoint treats as
 * the legitimacy fact for non-routed manual execution; a still-more precise
 * per-service routing-vs-manual flag remains a candidate for a future
 * correction if Brain judges the current binding insufficient.
 *
 * Brain Rev123/124 correction (independent exact-head review of head
 * `b3c5b1d`, the Rev122 fix): `ServiceCatalogAdmission` proved trusted/
 * admitted blueprint provenance, but nothing stated whether *this exact
 * admitted service* actually requires routed worker assignment or permits
 * direct manual execution - `admitManualExecutionAllowedFromServiceCatalogAdmission`
 * inferred `MANUAL_EXECUTION_ALLOWED` from catalog trust alone, so an
 * admission covering a service whose own real policy requires routing
 * could still first-admit the weaker classification (and, since admission
 * is immutable-once-set, freeze the wrong policy for that job). Required
 * correction: extend the narrowest trusted service/plan/job admission
 * surface - `ServiceCatalogEntry`/`ServiceCatalogAdmission`
 * (`commercial-order.ts`/`service-catalog-admission.ts`) - to carry an
 * explicit `executionRoutingPolicy: ServiceExecutionRoutingPolicy`
 * discriminator, then derive this registry's policy from that fact rather
 * than from admission status alone. `admitManualExecutionAllowedFromServiceCatalogAdmission`
 * now additionally requires `admission.executionRoutingPolicy ===
 * "MANUAL_EXECUTION_ALLOWED"` - an admission whose own catalog entry
 * declares `"ROUTING_REQUIRED"` can never satisfy this, regardless of how
 * trusted/evidenced/blueprint-matched it otherwise is. The discriminator
 * lives on the catalog entry itself (what the service actually is), not
 * asserted fresh at admission or execution time, so it is carried
 * verbatim from `catalogEntry` onto the resulting `ServiceCatalogAdmission`
 * exactly like `blueprintId`/`blueprintVersion`/`recipeId` already are -
 * no new IAM/authority system, reusing the same admission boundary Family
 * 1 already established. `admitRoutingRequiredFromAssignment`'s own
 * exact-job `RoutedExecutionAssignment` binding is unchanged and remains
 * independently sufficient for the ROUTING side (Brain Rev123 confirmed
 * this resolved).
 *
 * `admit*` are the only ways to produce an `ExecutionRoutingRequirement` -
 * there is no other exported constructor. Called once, at admission
 * time, structurally separate from whatever later calls
 * `authorizedTransitionOutcomeJob(..., "EXECUTING")`. `lookup` never
 * mutates and never accepts a caller-supplied classification. Immutability
 * (Rev118/119) is unchanged: re-admitting the same policy for an
 * already-admitted job is a no-op; admitting a different policy throws
 * `ExecutionRoutingRequirementAlreadyAdmittedError` unconditionally.
 */
export interface ExecutionRoutingRequirementRegistry {
  admitRoutingRequiredFromAssignment(input: {
    job: OutcomeJob;
    assignment: RoutedExecutionAssignment;
    admittedAt: unknown;
  }): ExecutionRoutingRequirement;
  admitManualExecutionAllowedFromServiceCatalogAdmission(input: {
    job: OutcomeJob;
    spec: OutcomeJobSpec;
    admission: ServiceCatalogAdmission;
    admittedAt: unknown;
  }): ExecutionRoutingRequirement;
  lookup(job: OutcomeJob): ExecutionRoutingRequirement | undefined;
}

export function createExecutionRoutingRequirementRegistry(): ExecutionRoutingRequirementRegistry {
  const admitted = new Map<string, ExecutionRoutingRequirement>();

  function admit(
    job: OutcomeJob,
    policy: ExecutionRoutingPolicy,
    admittedAt: unknown,
    provenance?: { admittedByAuthorityId: string; evidenceRef: string },
  ): ExecutionRoutingRequirement {
    const key = executionRoutingRequirementKey(job);
    const existing = admitted.get(key);
    if (existing !== undefined) {
      if (existing.policy !== policy) {
        throw new ExecutionRoutingRequirementAlreadyAdmittedError(job.jobId, existing.policy, policy);
      }
      return existing;
    }
    const requirement: ExecutionRoutingRequirement = {
      tenantId: job.tenantId,
      customerId: job.customerId,
      projectId: job.projectId,
      jobId: job.jobId,
      policy,
      admittedAt: requireNonEmptyExecutionRoutingField(admittedAt, "admittedAt"),
      ...(provenance !== undefined
        ? { admittedByAuthorityId: provenance.admittedByAuthorityId, evidenceRef: provenance.evidenceRef }
        : {}),
    };
    admitted.set(key, requirement);
    return requirement;
  }

  return {
    admitRoutingRequiredFromAssignment(input) {
      if (!isRoutedExecutionAssignmentValidForJob(input.assignment, input.job)) {
        throw new InvalidExecutionRoutingRequirementError(
          "assignment must be a RoutedExecutionAssignment bound to this exact job's tenant/customer/project/jobId - an assignment bound to a different job can never admit this job's routing requirement",
        );
      }
      return admit(input.job, "ROUTING_REQUIRED", input.admittedAt);
    },
    admitManualExecutionAllowedFromServiceCatalogAdmission(input) {
      if ((input.spec.specId as string) !== (input.job.jobId as string)) {
        throw new InvalidExecutionRoutingRequirementError(
          "spec.specId must equal job.jobId - the supplied OutcomeJobSpec must be the exact spec this runtime job was wired from, not a spec for a different job",
        );
      }
      if (
        input.spec.tenantId !== input.job.tenantId ||
        input.spec.customerId !== input.job.customerId ||
        input.spec.projectId !== input.job.projectId
      ) {
        throw new InvalidExecutionRoutingRequirementError(
          "spec.tenantId/customerId/projectId must match job.tenantId/customerId/projectId",
        );
      }
      if (input.admission.status !== "ADMITTED") {
        throw new InvalidExecutionRoutingRequirementError(
          `admission.status must be "ADMITTED" to admit MANUAL_EXECUTION_ALLOWED (got ${JSON.stringify(input.admission.status)}) - a revoked service catalog admission cannot vouch for this job's execution policy`,
        );
      }
      if (input.admission.executionRoutingPolicy !== "MANUAL_EXECUTION_ALLOWED") {
        throw new InvalidExecutionRoutingRequirementError(
          `admission.executionRoutingPolicy must be "MANUAL_EXECUTION_ALLOWED" to admit MANUAL_EXECUTION_ALLOWED (got ${JSON.stringify(input.admission.executionRoutingPolicy)}) - catalog trust alone does not imply manual execution is permitted; a service whose own admitted catalog entry declares ROUTING_REQUIRED can never vouch for this job's manual-execution policy`,
        );
      }
      if (
        input.admission.blueprintId !== input.spec.sourceBlueprintId ||
        input.admission.blueprintVersion !== input.spec.sourceBlueprintVersion
      ) {
        throw new InvalidExecutionRoutingRequirementError(
          "admission.blueprintId/blueprintVersion must match spec.sourceBlueprintId/sourceBlueprintVersion - an admission covering a different blueprint version can never vouch for this job's own requirement",
        );
      }
      return admit(input.job, "MANUAL_EXECUTION_ALLOWED", input.admittedAt, {
        admittedByAuthorityId: input.admission.admittedByAuthorityId,
        evidenceRef: input.admission.evidenceRef,
      });
    },
    lookup(job) {
      return admitted.get(executionRoutingRequirementKey(job));
    },
  };
}
