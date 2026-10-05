import type { TenantScope } from "./tenant-scope.js";
import { resolveEffectiveOrganizationAccess, type EffectiveAccessResolution } from "./effective-organization-access.js";
import type { Organization } from "./organization.js";
import type { OrganizationMembership } from "./organization-membership.js";
import type { OrganizationAccessRoleContext } from "./organization-access-role.js";
import { requireSameTenant, requirePermission, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";

export class InvalidProtectedDecisionRecordError extends Error {
  constructor(reason: string) {
    super(`Invalid ProtectedDecisionRecord: ${reason}`);
    this.name = "InvalidProtectedDecisionRecordError";
  }
}

/**
 * Rev188 F3-item4: the one legitimate lifecycle transition this module
 * recognizes - `APPROVED -> REVOKED`. `DENIED` and `REVOKED` are both
 * terminal (a decision that was denied, or already revoked, can never be
 * revised again) - mirrors the quota ledger's own terminal-disposition
 * discipline (`execution-quota-admission.ts`'s `QuotaReservationAlreadySettledError`),
 * reused as a pattern, never a second parallel lifecycle concept.
 */
export class ProtectedDecisionRecordTransitionError extends Error {
  constructor(decisionRef: string, fromOutcome: string, toOutcome: string) {
    super(
      `ProtectedDecisionRecord "${decisionRef}" cannot transition from "${fromOutcome}" to "${toOutcome}" - the only legitimate transition is APPROVED -> REVOKED; DENIED and REVOKED are both terminal`,
    );
    this.name = "ProtectedDecisionRecordTransitionError";
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
 * this module adds exactly one: a real, durably-recorded outcome.
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

/**
 * Rev188 F3-item4: `createProtectedDecisionRecord`/`reviseProtectedDecisionRecord`
 * previously trusted any caller-supplied, structurally-valid
 * `EffectiveAccessResolution` object directly - but
 * `resolveEffectiveOrganizationAccess`'s own doc comment is explicit that
 * it never authenticates `currentPrincipalRef` itself, only proves the
 * supplied membership belongs to the identity the caller currently
 * ASSERTS. Both functions now take the raw `organization`/`membership`/
 * `currentPrincipalRef`/`roleContext`/`authority` ingredients instead and
 * resolve access themselves, immediately before use - the SAME fix
 * already applied to `mutateConnectorConnectionStateAsAdmin` (Rev187 F2)
 * and `resumeProtectedDecisionAndExecuteConnectorEffect` (Rev188 item2).
 * `requirePermission(authority, "EXECUTE")` and
 * `requireProtectedActionAuthorization` are also required here, exactly
 * mirroring `authorizeProtectedDecisionResume`'s own authority floor for
 * the symmetric RESUME edge - a decision's record is no less protected
 * than its later consumption.
 */
function resolveAuthenticatedDecisionAccess(input: {
  readonly tenantScope: TenantScope;
  readonly organization: Organization;
  readonly membership: OrganizationMembership;
  readonly currentPrincipalRef: string;
  readonly roleContext?: OrganizationAccessRoleContext;
  readonly authority: AuthorityContext;
  readonly actionName: string;
}): EffectiveAccessResolution {
  requireSameTenant(input.authority, input.tenantScope.tenantId);
  requirePermission(input.authority, "EXECUTE");
  requireProtectedActionAuthorization(input.authority, input.actionName);
  const access = resolveEffectiveOrganizationAccess({
    organization: input.organization,
    membership: input.membership,
    currentPrincipalRef: input.currentPrincipalRef,
    authority: input.authority,
    ...(input.roleContext !== undefined ? { roleContext: input.roleContext } : {}),
  });
  if (access.decision !== "GRANTED") {
    throw new InvalidProtectedDecisionRecordError(
      `current access must resolve GRANTED to record a protected decision (reasons: ${access.reasons.join("; ")})`,
    );
  }
  if (access.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProtectedDecisionRecordError("access does not belong to the given tenantScope");
  }
  if (access.membershipId === undefined) {
    throw new InvalidProtectedDecisionRecordError(
      "access must be bound to a real OrganizationMembership (a current authenticated principal) to record a decision",
    );
  }
  return access;
}

export function createProtectedDecisionRecord(input: {
  readonly tenantScope: TenantScope;
  readonly decisionRef: unknown;
  readonly outcome: unknown;
  readonly organization: Organization;
  readonly membership: OrganizationMembership;
  readonly currentPrincipalRef: string;
  readonly roleContext?: OrganizationAccessRoleContext;
  readonly authority: AuthorityContext;
  readonly decidedAt: unknown;
  readonly evidenceRef: unknown;
}): ProtectedDecisionRecord {
  const decisionRef = requireNonEmptyString(input.decisionRef, "decisionRef");
  if (typeof input.outcome !== "string" || !VALID_OUTCOMES.has(input.outcome)) {
    throw new InvalidProtectedDecisionRecordError('outcome must be exactly "APPROVED", "DENIED", or "REVOKED"');
  }
  resolveAuthenticatedDecisionAccess({
    tenantScope: input.tenantScope,
    organization: input.organization,
    membership: input.membership,
    currentPrincipalRef: input.currentPrincipalRef,
    authority: input.authority,
    ...(input.roleContext !== undefined ? { roleContext: input.roleContext } : {}),
    actionName: "createProtectedDecisionRecord",
  });
  return {
    decisionRef,
    tenantId: input.tenantScope.tenantId,
    outcome: input.outcome as ProtectedDecisionOutcome,
    // Rev189 R4: the proven AUTHENTICATED PRINCIPAL ref, never
    // `access.membershipId` - a membership id identifies an
    // OrganizationMembership record, a structurally different identity
    // from the principal who was actually authenticated. A field named
    // `decidedByPrincipalRef` must store the principal, not the
    // membership.
    decidedByPrincipalRef: input.currentPrincipalRef,
    decidedAt: requireNonEmptyString(input.decidedAt, "decidedAt"),
    evidenceRef: requireNonEmptyString(input.evidenceRef, "evidenceRef"),
  };
}

/**
 * Rev188 F3-item4: the ONE legitimate revision of an already-durably-recorded
 * decision - `current.outcome` must be `"APPROVED"` and the requested
 * `outcome` must be exactly `"REVOKED"`; any other starting outcome (a
 * terminal `DENIED`/`REVOKED`) or any other target outcome is rejected
 * before the authenticated-access check even runs (a transition that can
 * never be legitimate needs no access proof to also reject it). The
 * durable store (`durable-protected-decision-record-store.ts`) is what
 * actually makes this single-use per `decisionRef` - this function alone
 * has no persistence and validates only the transition shape/authority.
 */
export function reviseProtectedDecisionRecord(input: {
  readonly current: ProtectedDecisionRecord;
  readonly tenantScope: TenantScope;
  readonly outcome: unknown;
  readonly organization: Organization;
  readonly membership: OrganizationMembership;
  readonly currentPrincipalRef: string;
  readonly roleContext?: OrganizationAccessRoleContext;
  readonly authority: AuthorityContext;
  readonly decidedAt: unknown;
  readonly evidenceRef: unknown;
}): ProtectedDecisionRecord {
  if (input.current.tenantId !== input.tenantScope.tenantId) {
    throw new InvalidProtectedDecisionRecordError("current record does not belong to the given tenantScope");
  }
  const targetOutcome = typeof input.outcome === "string" ? input.outcome : String(input.outcome);
  if (input.current.outcome !== "APPROVED" || targetOutcome !== "REVOKED") {
    throw new ProtectedDecisionRecordTransitionError(input.current.decisionRef, input.current.outcome, targetOutcome);
  }
  resolveAuthenticatedDecisionAccess({
    tenantScope: input.tenantScope,
    organization: input.organization,
    membership: input.membership,
    currentPrincipalRef: input.currentPrincipalRef,
    authority: input.authority,
    ...(input.roleContext !== undefined ? { roleContext: input.roleContext } : {}),
    actionName: "reviseProtectedDecisionRecord",
  });
  return {
    decisionRef: input.current.decisionRef,
    tenantId: input.current.tenantId,
    outcome: "REVOKED",
    // Rev189 R4: see createProtectedDecisionRecord's own note - the
    // proven authenticated principal, never the membership id.
    decidedByPrincipalRef: input.currentPrincipalRef,
    decidedAt: requireNonEmptyString(input.decidedAt, "decidedAt"),
    evidenceRef: requireNonEmptyString(input.evidenceRef, "evidenceRef"),
  };
}
