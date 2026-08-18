import type { TenantScope } from "./tenant-scope.js";
import type { OutcomeJob } from "./outcome-job.js";

export class InvalidAuditEventError extends Error {
  constructor(reason: string) {
    super(`Invalid AuditEvent: ${reason}`);
    this.name = "InvalidAuditEventError";
  }
}

type AuditEventId = string & { readonly __brand: "AuditEventId" };

/**
 * Immutable/append-only at domain-contract level (AKI-BE-001 execution
 * record, "Scope (Minimum Domain Objects)" #6). No secret values or
 * unnecessary raw payloads (T10): `relatedRefs` are references/locators
 * only, matching `EvidenceReference`'s own "reference, not embedded
 * secret material" discipline - this contract has no field designed to
 * hold raw secret/customer-payload content. Records lineage - kept
 * structurally distinct from `EvidenceReference` (supports a claim) and
 * `VerificationResult` (the verification decision itself), per DEC-122
 * RG-04.
 */
export interface AuditEvent {
  readonly eventId: AuditEventId;
  readonly tenantId: TenantScope["tenantId"];
  readonly jobId: OutcomeJob["jobId"];
  readonly projectId: OutcomeJob["projectId"];
  readonly actorRef: string;
  readonly eventType: string;
  readonly timestamp: string;
  readonly reason?: string;
  readonly relatedRefs: ReadonlyArray<string>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidAuditEventError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidAuditEventError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidAuditEventError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidAuditEventError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * Preserves tenant/job/project correlation structurally (T10): these
 * fields come from the given `OutcomeJob`, not from free caller input.
 */
export function createAuditEvent(input: {
  job: OutcomeJob;
  eventId: unknown;
  actorRef: unknown;
  eventType: unknown;
  timestamp: unknown;
  reason?: unknown;
  relatedRefs?: unknown;
}): AuditEvent {
  const eventId = requireNonEmptyString(input.eventId, "eventId");
  const actorRef = requireNonEmptyString(input.actorRef, "actorRef");
  const eventType = requireNonEmptyString(input.eventType, "eventType");
  const timestamp = requireNonEmptyString(input.timestamp, "timestamp");

  let reason: string | undefined;
  if (input.reason !== undefined) {
    reason = requireNonEmptyString(input.reason, "reason");
  }

  let relatedRefs: string[] = [];
  if (input.relatedRefs !== undefined) {
    if (!Array.isArray(input.relatedRefs)) {
      throw new InvalidAuditEventError(
        "relatedRefs must be an array of strings",
      );
    }
    relatedRefs = input.relatedRefs.map((ref: unknown, index: number) =>
      requireNonEmptyString(ref, `relatedRefs[${index}]`),
    );
  }

  return {
    eventId: eventId as AuditEventId,
    tenantId: input.job.tenantId,
    jobId: input.job.jobId,
    projectId: input.job.projectId,
    actorRef,
    eventType,
    timestamp,
    ...(reason !== undefined ? { reason } : {}),
    relatedRefs,
  };
}
