import type { TenantScope } from "./tenant-scope.js";
import type { Project } from "./project.js";
import type { AuditEvent } from "./audit-event.js";

export class InvalidDeliveryTimelineError extends Error {
  constructor(reason: string) {
    super(`Invalid DeliveryTimeline: ${reason}`);
    this.name = "InvalidDeliveryTimelineError";
  }
}

/**
 * V2 Client & Delivery OS - first bounded slice ("unified delivery
 * timeline", AKILTA + AI Commerce Master Release Plan v1.0 Section 5).
 * CR-1 (Brain CHANGES_REQUIRED on checkpoint b37440d, 2026-08-21):
 * AuditEvent stays internal. The customer-facing timeline must not
 * expose raw `reason`, `actorRef`, `relatedRefs`, or arbitrary free-form
 * `eventType` - only a deterministic, closed-set customer-safe category.
 */
export type CustomerTimelineCategory =
  | "STATUS_UPDATE"
  | "BLOCKER"
  | "VERIFICATION"
  | "ACTION_REQUIRED"
  | "WORKING_ARTIFACT"
  | "APPROVAL";

/**
 * Deterministic, closed-set mapping from the raw `AuditEvent.eventType`
 * strings this repository's domain kernel actually produces today (see
 * `enterExceptionState` in outcome-job.ts, the only current producer) to
 * a `CustomerTimelineCategory`. An unmapped eventType is not guessed at -
 * it fails closed by omission (filtered out of the customer timeline
 * entirely), per CR-1's explicit instruction not to invent ad-hoc
 * redaction/classifier logic.
 */
const EVENT_TYPE_TO_CUSTOMER_CATEGORY: ReadonlyMap<string, CustomerTimelineCategory> = new Map([
  ["EXCEPTION_STATE_ENTERED:BLOCKED", "BLOCKER"],
  ["EXCEPTION_STATE_ENTERED:RECOVERING", "STATUS_UPDATE"],
  ["EXCEPTION_STATE_ENTERED:ESCALATED", "ACTION_REQUIRED"],
  ["EXCEPTION_STATE_ENTERED:STOPPED", "BLOCKER"],
]);

export interface DeliveryTimelineEntry {
  readonly eventId: AuditEvent["eventId"];
  readonly jobId: AuditEvent["jobId"];
  readonly category: CustomerTimelineCategory;
  readonly timestamp: string;
}

export interface DeliveryTimeline {
  readonly tenantId: TenantScope["tenantId"];
  readonly projectId: Project["projectId"];
  readonly entries: ReadonlyArray<DeliveryTimelineEntry>;
}

/**
 * Every input event must belong to the given project (same tenantId and
 * projectId) - same "cross-tenant/wrong-project ... binding fails closed"
 * discipline as `computeDeliveryStatus` and DEL-003 T7; a foreign event is
 * treated as contamination, not silently dropped. This check runs before
 * category mapping/filtering, so a contaminated input still fails closed
 * even if none of its events would otherwise map to a customer category.
 *
 * Entries are sorted ascending by `timestamp` using a plain string
 * comparison (existing timestamps in this repository are ISO-8601, for
 * which lexicographic order already equals chronological order).
 */
export function buildDeliveryTimeline(input: {
  project: Project;
  auditEvents: ReadonlyArray<AuditEvent>;
}): DeliveryTimeline {
  for (const event of input.auditEvents) {
    if (event.tenantId !== input.project.tenantId) {
      throw new InvalidDeliveryTimelineError(
        `event ${event.eventId} belongs to a different tenant than the given project`,
      );
    }
    if (event.projectId !== input.project.projectId) {
      throw new InvalidDeliveryTimelineError(
        `event ${event.eventId} belongs to a different project than the given project`,
      );
    }
  }

  const entries: DeliveryTimelineEntry[] = input.auditEvents
    .map((event) => {
      const category = EVENT_TYPE_TO_CUSTOMER_CATEGORY.get(event.eventType);
      if (category === undefined) {
        return undefined;
      }
      return {
        eventId: event.eventId,
        jobId: event.jobId,
        category,
        timestamp: event.timestamp,
      };
    })
    .filter((entry): entry is DeliveryTimelineEntry => entry !== undefined)
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  return {
    tenantId: input.project.tenantId,
    projectId: input.project.projectId,
    entries,
  };
}
