import type { TenantScope } from "./tenant-scope.js";
import type { OutcomeJob, OutcomeJobState } from "./outcome-job.js";
import type { AuditEvent } from "./audit-event.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import { resolveCurrentOwner, type OwnershipAssignment } from "./ownership-assignment.js";

export class InvalidAttentionStateError extends Error {
  constructor(reason: string) {
    super(`Invalid AttentionState: ${reason}`);
    this.name = "InvalidAttentionStateError";
  }
}

/**
 * V3 Workstream D (§7), spine item E. "At-risk/breach/escalation
 * requires authoritative source state" - the only authoritative signal
 * this repository has for internal exception/escalation is the existing
 * `OutcomeJobState` exception-state set from AKI-BE-001
 * (`BLOCKED`/`RECOVERING`/`ESCALATED`/`STOPPED`, see `outcome-job.ts`).
 * No due-date, target-completion, or SLA-clock field exists anywhere in
 * this repository, so this module deliberately does NOT invent an
 * "AT_RISK" heuristic (e.g. time-in-state or an implied deadline) - that
 * would be exactly the invented business rule DEC-153's Activation
 * Discipline forbids. `internalAttentionLevel` is a direct, honest
 * mapping of the existing state signal: `NORMAL` (not in an exception
 * state), `EXCEPTION` (`BLOCKED`/`RECOVERING`/`STOPPED`), or `ESCALATED`
 * (`ESCALATED` exactly) - nothing in between is claimed.
 */
export type InternalAttentionLevel = "NORMAL" | "EXCEPTION" | "ESCALATED";

const EXCEPTION_STATES: ReadonlySet<OutcomeJobState> = new Set<OutcomeJobState>([
  "BLOCKED",
  "RECOVERING",
  "STOPPED",
]);

/**
 * §7: "internal operating target and customer-contractual SLA are
 * separate truths" + "missing/unknown commitment remains unknown." No
 * contractual SLA/commitment data source exists anywhere in this
 * repository, so `contractualSlaStatus` is always `"UNKNOWN"` in this
 * bounded slice - the single-literal type makes it structurally
 * impossible for this module to ever claim a known contractual
 * commitment. Same "declared honestly as UNKNOWN, not invented"
 * discipline already established by `EtaProjection` in
 * `client-project-snapshot.ts` (V2-CDO-005).
 */
export type ContractualSlaStatus = "UNKNOWN";

/**
 * §7: "state includes responsible owner, reason, timestamp and
 * next-safe-action where available." `responsibleOwnerMembershipId`
 * reuses `resolveCurrentOwner` (V3-OWN-001) against the `DELIVERY_OWNER`
 * role rather than inventing a separate escalation-owner concept.
 * `reason`/`timestamp` are surfaced only when `internalAttentionLevel`
 * is not `NORMAL` (§7: "stale/unsupported SLA states cannot appear as
 * current contractual truth" - the same discipline applied here to
 * internal state: a resolved exception's old reason/timestamp is never
 * shown as if the job were still in that state). There is no
 * "next-safe-action" source anywhere in this repository, so that field
 * is not present at all in this slice - never fabricated.
 *
 * §7 acceptance direction: "escalation visibility does not create
 * execution/approval authority." This module imports no create/
 * transition function from `outcome-job.ts` (only its types) and
 * nothing from `authority.ts` - constructing or reading an
 * `AttentionState` cannot itself transition an `OutcomeJob` or grant any
 * permission.
 *
 * CXP-001F correction: `AttentionState` previously carried no
 * `customerId`, so downstream consumers (`operations-attention.ts`,
 * `team-attention-projection.ts`) could only cross-check it against a
 * separately-supplied job/ownership reference on `tenantId`+`projectId`
 * (or `tenantId`+`jobId`) - dimensions CXP-001C/D already established are
 * not sufficient to distinguish two different customers sharing a
 * `projectId`/`jobId` string within the same tenant. `customerId` is now
 * carried on `AttentionState` itself so those consumers can close that
 * join gap directly rather than trusting an uncross-checked caller-
 * supplied value.
 */
export interface AttentionState {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: OutcomeJob["customerId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly projectId: OutcomeJob["projectId"];
  readonly internalAttentionLevel: InternalAttentionLevel;
  readonly contractualSlaStatus: ContractualSlaStatus;
  readonly responsibleOwnerMembershipId?: OwnershipAssignment["membershipId"];
  readonly reason?: string;
  readonly timestamp?: string;
}

/**
 * §7 acceptance direction (implicit fail-closed discipline, matching
 * every other projection in this repository): a caller-supplied
 * `latestExceptionEvent` must belong to the exact same job/tenant/customer
 * as `job`, or construction rejects rather than silently attributing a
 * foreign event's reason/timestamp to this job. Likewise, a caller-supplied
 * `ownership` must match the job's tenant/customer/project identity before
 * it is used to resolve a responsible owner.
 *
 * CXP-001E correction: `jobId` is a derived, human-readable string, not a
 * globally unique identifier (see `evidence.ts`), so a same-tenant,
 * same-jobId `AuditEvent` or `ProjectOwnershipRef` genuinely belonging to
 * a different customer could previously pass the tenantId-only (and,
 * for ownership, tenantId+projectId-only) check and leak that foreign
 * customer's raw exception reason/timestamp or resolved delivery owner
 * into this job's `AttentionState`. Both checks now also require
 * `customerId` to match - `AuditEvent.customerId` (CXP-001C) and
 * `ProjectOwnershipRef.customerId` were already available but not yet
 * consulted here.
 */
export function buildAttentionState(input: {
  job: OutcomeJob;
  latestExceptionEvent?: AuditEvent;
  ownershipHistory?: ReadonlyArray<OwnershipAssignment>;
  ownership?: ProjectOwnershipRef;
}): AttentionState {
  if (input.latestExceptionEvent !== undefined) {
    if (input.latestExceptionEvent.jobId !== input.job.jobId) {
      throw new InvalidAttentionStateError(
        "latestExceptionEvent does not belong to the given job",
      );
    }
    if (input.latestExceptionEvent.tenantId !== input.job.tenantId) {
      throw new InvalidAttentionStateError(
        "latestExceptionEvent belongs to a different tenant than the given job",
      );
    }
    if (input.latestExceptionEvent.customerId !== input.job.customerId) {
      throw new InvalidAttentionStateError(
        "latestExceptionEvent belongs to a different customer than the given job",
      );
    }
  }

  let internalAttentionLevel: InternalAttentionLevel;
  if (input.job.state === "ESCALATED") {
    internalAttentionLevel = "ESCALATED";
  } else if (EXCEPTION_STATES.has(input.job.state)) {
    internalAttentionLevel = "EXCEPTION";
  } else {
    internalAttentionLevel = "NORMAL";
  }
  const isCurrentlyInException = internalAttentionLevel !== "NORMAL";

  let responsibleOwnerMembershipId: OwnershipAssignment["membershipId"] | undefined;
  if (input.ownershipHistory !== undefined && input.ownership !== undefined) {
    if (
      input.ownership.tenantId !== input.job.tenantId ||
      input.ownership.customerId !== input.job.customerId ||
      input.ownership.projectId !== input.job.projectId
    ) {
      throw new InvalidAttentionStateError(
        "ownership does not match the given job's tenant/customer/project identity",
      );
    }
    const currentDeliveryOwner = resolveCurrentOwner({
      history: input.ownershipHistory,
      ownership: input.ownership,
      ownerRole: "DELIVERY_OWNER",
    });
    responsibleOwnerMembershipId = currentDeliveryOwner?.membershipId;
  }

  return {
    tenantId: input.job.tenantId,
    customerId: input.job.customerId,
    jobId: input.job.jobId,
    projectId: input.job.projectId,
    internalAttentionLevel,
    contractualSlaStatus: "UNKNOWN",
    ...(responsibleOwnerMembershipId !== undefined ? { responsibleOwnerMembershipId } : {}),
    ...(isCurrentlyInException && input.latestExceptionEvent?.reason !== undefined
      ? { reason: input.latestExceptionEvent.reason }
      : {}),
    ...(isCurrentlyInException && input.latestExceptionEvent !== undefined
      ? { timestamp: input.latestExceptionEvent.timestamp }
      : {}),
  };
}
