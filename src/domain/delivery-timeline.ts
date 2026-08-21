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
 * timeline", AKILTA + AI Commerce Master Release Plan v1.0 Section 5,
 * "AKILTA v2.0 - CLIENT & DELIVERY OS"). A pure chronological projection
 * over already-canonical `AuditEvent` records for one project. It exposes
 * only the fields `AuditEvent` itself already documents as safe to
 * reference (no secret values, no unnecessary raw payload; see
 * `audit-event.ts`) and deliberately omits `relatedRefs` - narrowing what
 * a first bounded slice exposes is safer than guessing at a customer-
 * visibility classification for arbitrary `eventType` strings, which the
 * canonical source does not define. This is a minimal exposed surface,
 * not a claim that every field is customer-appropriate for every future
 * eventType.
 */
export interface DeliveryTimelineEntry {
  readonly eventId: AuditEvent["eventId"];
  readonly jobId: AuditEvent["jobId"];
  readonly eventType: string;
  readonly timestamp: string;
  readonly reason?: string;
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
 * treated as contamination, not silently dropped.
 *
 * Entries are sorted ascending by `timestamp` using a plain string
 * comparison. Every existing timestamp value in this repository is an
 * ISO-8601 string (see `AuditEvent.timestamp`, `createAuditEvent`), for
 * which lexicographic order already equals chronological order; this
 * function does not parse or reformat the timestamp, and does not invent
 * a fallback for non-ISO-8601 input.
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
    .map((event) => ({
      eventId: event.eventId,
      jobId: event.jobId,
      eventType: event.eventType,
      timestamp: event.timestamp,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
    }))
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  return {
    tenantId: input.project.tenantId,
    projectId: input.project.projectId,
    entries,
  };
}
