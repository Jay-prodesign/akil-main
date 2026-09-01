import type { TenantScope } from "./tenant-scope.js";
import type { AttentionState, InternalAttentionLevel } from "./attention-state.js";

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
 * §6 required semantics: "each item retains source domain,
 * tenant/client/project/service/capability context, severity/urgency
 * evidence, accountable owner and next-safe-action reference where
 * known." This module reuses `AttentionState`'s own
 * `internalAttentionLevel`/`responsibleOwnerMembershipId`/`reason`/
 * `timestamp` verbatim as the severity/urgency/owner/evidence fields -
 * no parallel severity or ownership concept is invented. `isActive` is
 * a direct, honest derivation (`internalAttentionLevel !== "NORMAL"`),
 * not a separately trackable/mutable flag, so "stale resolved source
 * cannot remain active" (§6 acceptance) holds structurally: this value
 * is always recomputed from the exact `AttentionState` given, never
 * cached or independently toggled. `contractualSlaStatus` is
 * deliberately NOT carried into this aggregation - V3-SLA-001 already
 * established internal-attention and customer-contractual-SLA as
 * separate truths, and conflating them into one aggregated "attention"
 * concept would blur exactly the distinction that module exists to
 * preserve. No `nextSafeActionRef` field exists on this type at all -
 * no source for it exists anywhere in this repository, so it is
 * honestly omitted rather than fabricated (same discipline already
 * applied to `AttentionState` itself, §7).
 */
export interface OperationsAttentionItem {
  readonly sourceDomain: AttentionSourceDomain;
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: AttentionState["projectId"];
  readonly jobId: AttentionState["jobId"];
  readonly isActive: boolean;
  readonly internalAttentionLevel: InternalAttentionLevel;
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
 */
export function toOperationsAttentionItem(state: AttentionState): OperationsAttentionItem {
  return {
    sourceDomain: "DELIVERY_OUTCOME_JOB",
    tenantId: state.tenantId,
    projectId: state.projectId,
    jobId: state.jobId,
    isActive: state.internalAttentionLevel !== "NORMAL",
    internalAttentionLevel: state.internalAttentionLevel,
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
 * only ever narrows the given list to the exact tenant/project scope
 * requested - an item for a different tenant or project is excluded,
 * never coerced into the requested scope.
 *
 * §6 acceptance direction: "escalation and next action are separately
 * authorized." This function exports no escalation/dismiss/resolve
 * capability - it is read-only aggregation/filtering only.
 */
export function resolveActiveOperationsAttention(input: {
  items: ReadonlyArray<OperationsAttentionItem>;
  tenantId: TenantScope["tenantId"];
  projectId: AttentionState["projectId"];
}): ReadonlyArray<OperationsAttentionItem> {
  return input.items.filter(
    (item) =>
      item.isActive && item.tenantId === input.tenantId && item.projectId === input.projectId,
  );
}
