import type { TenantScope } from "./tenant-scope.js";
import type { EffectiveAccessResolution } from "./effective-organization-access.js";

export class InvalidProtectedDecisionRecordError extends Error {
  constructor(reason: string) {
    super(`Invalid ProtectedDecisionRecord: ${reason}`);
    this.name = "InvalidProtectedDecisionRecordError";
  }
}

export type ProtectedDecisionOutcome = "APPROVED" | "DENIED" | "REVOKED";

const VALID_OUTCOMES: ReadonlySet<string> = new Set(["APPROVED", "DENIED", "REVOKED"]);

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidProtectedDecisionRecordError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Rev187 F3b (durable-decision residual): "matching decisionRef + a
 * non-empty evidenceRef does not prove an authorized durable decision" -
 * this is the minimum bounded durable record this exact WAIT->RESUME gate
 * needs. `ApprovalReference` (`approval-reference.ts`) was evaluated first
 * and does not fit: its identity is bound to a `ProjectPlanVersion`
 * (plan id/version/content-hash), a structurally different artifact from
 * a protected-decision `decisionRef` - reusing it would mean fabricating a
 * fake plan just to produce an approval, not a real reuse. No other
 * existing durable decision/approval owner exists in this repository, so
 * this module adds exactly one: a real, durably-recorded outcome, created
 * once per `decisionRef`, requiring the SAME current-authenticated-
 * principal proof (`EffectiveAccessResolution`, GRANTED, same tenant,
 * `membershipId` present) `authorizeProtectedDecisionResume` itself
 * requires for resume - `decidedByPrincipalRef` is therefore always
 * derived from `access.membershipId`, never a caller-supplied bare label.
 *
 * `outcome` is exactly `"APPROVED" | "DENIED" | "REVOKED"` - a decision
 * that denies or revokes the protected action is recorded explicitly, not
 * represented by the mere absence of a record (absence must ALSO fail
 * closed - see `durable-protected-decision-record-store.ts`'s
 * `getDecisionRecord`, which returns `undefined` for no record, never a
 * default outcome).
 */
export interface ProtectedDecisionRecord {
  readonly decisionRef: string;
  readonly tenantId: TenantScope["tenantId"];
  readonly outcome: ProtectedDecisionOutcome;
  readonly decidedByPrincipalRef: string;
  readonly decidedAt: string;
  readonly evidenceRef: string;
}

export function createProtectedDecisionRecord(input: {
  readonly tenantScope: TenantScope;
  readonly decisionRef: unknown;
  readonly outcome: unknown;
  readonly decidedByAccess: EffectiveAccessResolution;
  readonly decidedAt: unknown;
  readonly evidenceRef: unknown;
}): ProtectedDecisionRecord {
  const decisionRef = requireNonEmptyString(input.decisionRef, "decisionRef");
  if (typeof input.outcome !== "string" || !VALID_OUTCOMES.has(input.outcome)) {
    throw new InvalidProtectedDecisionRecordError('outcome must be exactly "APPROVED", "DENIED", or "REVOKED"');
  }
  if (input.decidedByAccess.decision !== "GRANTED") {
    throw new InvalidProtectedDecisionRecordError(
      "decidedByAccess must be a GRANTED EffectiveAccessResolution - a decision can only be recorded by a current authenticated principal",
    );
  }
  if (input.decidedByAccess.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProtectedDecisionRecordError("decidedByAccess does not belong to the given tenantScope");
  }
  if (input.decidedByAccess.membershipId === undefined) {
    throw new InvalidProtectedDecisionRecordError(
      "decidedByAccess must be bound to a real OrganizationMembership (a current authenticated principal) to record a decision",
    );
  }
  return {
    decisionRef,
    tenantId: input.tenantScope.tenantId,
    outcome: input.outcome as ProtectedDecisionOutcome,
    decidedByPrincipalRef: input.decidedByAccess.membershipId,
    decidedAt: requireNonEmptyString(input.decidedAt, "decidedAt"),
    evidenceRef: requireNonEmptyString(input.evidenceRef, "evidenceRef"),
  };
}
