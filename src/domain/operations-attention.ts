import type { TenantScope } from "./tenant-scope.js";
import type { AttentionState, InternalAttentionLevel } from "./attention-state.js";
import type { OutcomeJob } from "./outcome-job.js";

export class InvalidOperationsAttentionItemError extends Error {
  constructor(reason: string) {
    super(`Invalid OperationsAttentionItem: ${reason}`);
    this.name = "InvalidOperationsAttentionItemError";
  }
}

/**
 * V4 Full Blueprint §6, Workstream B, spine item C - "aggregate what
 * needs human/automation attention across services without flattening
 * distinct domain truth." §6 lists eleven candidate attention families
 * (blocked dependency, customer approval required, provider wait,
 * credential/access problem, SLA/operating risk, failed external
 * effect, telemetry anomaly, policy restriction, data-quality
 * uncertainty, recovery required, optimization opportunity), but only
 * one real source-domain attention signal exists anywhere in this
 * repository today: `AttentionState` (V3-SLA-001, derived from
 * `OutcomeJobState`). This module deliberately does NOT invent the
 * other ten families - a single-literal union makes it structurally
 * impossible to claim a source domain this repository cannot actually
 * observe. Adding a real second source domain (e.g. a capability/
 * provider-wait signal once V4-SVC-001's `ServiceCapabilityRoute` gains
 * a genuine provider adapter) is additive to this union, not a breaking
 * change.
 */
export type AttentionSourceDomain = "DELIVERY_OUTCOME_JOB";

/**
 * Bounded correction (Brain handoff Rev28, CHANGES_REQUIRED_SOURCE_SEMANTICS
 * on PR #7): "Current attention items omit customer/client isolation...
 * Tenant+project filtering alone is insufficient for cross-client
 * isolation." `AttentionState` (V3-SLA-001) itself carries no customerId,
 * so this type cannot be filled from it alone without fabricating a
 * join. `OutcomeJob` (AKI-BE-001) already carries an authoritative
 * `customerId` for the exact same job, so `toOperationsAttentionItem`
 * below now requires the originating `OutcomeJob` as well, verifies it
 * actually identifies the same tenant/project/job as the given
 * `AttentionState` (fail closed on any mismatch), and only then reuses
 * its `customerId` directly - never independently supplied or guessed.
 *
 * `evidenceFreshness` is the second Rev28 requirement: "represent
 * freshness so absent/stale evidence cannot look current." Because
 * `buildAttentionState` can honestly report `isActive: true` on a job
 * already in an exception state even when no `latestExceptionEvent` was
 * supplied to it (so `reason`/`timestamp` stay absent), an aggregated
 * item could otherwise look identically "active" whether or not real
 * evidence backs it. `evidenceFreshness` makes that distinction
 * explicit and structural: `"CURRENT"` only when both `reason` and
 * `timestamp` are present (i.e. backed by a real `AuditEvent`),
 * `"UNKNOWN"` in every other case (including a `NORMAL`/inactive item,
 * which makes no attention claim to be fresh or stale about in the
 * first place) - never inferred or defaulted to `"CURRENT"`.
 */
export interface OperationsAttentionItem {
  readonly sourceDomain: AttentionSourceDomain;
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: OutcomeJob["customerId"];
  readonly projectId: AttentionState["projectId"];
  readonly jobId: AttentionState["jobId"];
  readonly isActive: boolean;
  readonly internalAttentionLevel: InternalAttentionLevel;
  readonly evidenceFreshness: "CURRENT" | "UNKNOWN";
  readonly responsibleOwnerMembershipId?: AttentionState["responsibleOwnerMembershipId"];
  readonly reason?: string;
  readonly timestamp?: string;
}

/**
 * §6 acceptance direction: "UI aggregation cannot manufacture status."
 * This function reads every field directly off the given `AttentionState`
 * (itself produced solely by `buildAttentionState`, V3-SLA-001) and adds
 * no independent judgment of its own beyond the mechanical `isActive`
 * derivation - it cannot promote/demote urgency, invent an owner, or
 * fabricate a reason/timestamp the source state does not already carry.
 *
 * Rev28 bounded correction: `job` must identify the exact same
 * tenant/project/job as `state` - a mismatched `OutcomeJob` is rejected
 * rather than silently attributing its `customerId` to a foreign
 * `AttentionState` (no fabricated join).
 */
export function toOperationsAttentionItem(input: {
  state: AttentionState;
  job: OutcomeJob;
}): OperationsAttentionItem {
  const { state, job } = input;
  if (job.jobId !== state.jobId) {
    throw new InvalidOperationsAttentionItemError(
      "job does not identify the same jobId as the given AttentionState",
    );
  }
  if (job.tenantId !== state.tenantId) {
    throw new InvalidOperationsAttentionItemError(
      "job belongs to a different tenant than the given AttentionState",
    );
  }
  if (job.projectId !== state.projectId) {
    throw new InvalidOperationsAttentionItemError(
      "job belongs to a different project than the given AttentionState",
    );
  }
  return {
    sourceDomain: "DELIVERY_OUTCOME_JOB",
    tenantId: state.tenantId,
    customerId: job.customerId,
    projectId: state.projectId,
    jobId: state.jobId,
    isActive: state.internalAttentionLevel !== "NORMAL",
    internalAttentionLevel: state.internalAttentionLevel,
    evidenceFreshness:
      state.reason !== undefined && state.timestamp !== undefined ? "CURRENT" : "UNKNOWN",
    ...(state.responsibleOwnerMembershipId !== undefined
      ? { responsibleOwnerMembershipId: state.responsibleOwnerMembershipId }
      : {}),
    ...(state.reason !== undefined ? { reason: state.reason } : {}),
    ...(state.timestamp !== undefined ? { timestamp: state.timestamp } : {}),
  };
}

/**
 * §6 acceptance direction: "cross-client attention leakage rejects."
 * This is a pure filter, not a mutation: it never alters any item, and
 * only ever narrows the given list to the exact tenant/customer/project
 * scope requested - an item for a different tenant, customer, or
 * project is excluded, never coerced into the requested scope. Rev28
 * bounded correction: tenant+project filtering alone was insufficient
 * for cross-client isolation (two customers can share a tenant), so
 * `customerId` is now a required, independently-checked filter key.
 *
 * §6 acceptance direction: "escalation and next action are separately
 * authorized." This function exports no escalation/dismiss/resolve
 * capability - it is read-only aggregation/filtering only.
 */
export function resolveActiveOperationsAttention(input: {
  items: ReadonlyArray<OperationsAttentionItem>;
  tenantId: TenantScope["tenantId"];
  customerId: OutcomeJob["customerId"];
  projectId: AttentionState["projectId"];
}): ReadonlyArray<OperationsAttentionItem> {
  return input.items.filter(
    (item) =>
      item.isActive &&
      item.tenantId === input.tenantId &&
      item.customerId === input.customerId &&
      item.projectId === input.projectId,
  );
}
