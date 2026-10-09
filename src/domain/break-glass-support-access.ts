import type { TenantScope } from "./tenant-scope.js";

export class InvalidBreakGlassAccessGrantError extends Error {
  constructor(reason: string) {
    super(`Invalid BreakGlassAccessGrant operation: ${reason}`);
    this.name = "InvalidBreakGlassAccessGrantError";
  }
}

export class BreakGlassSupportAccessDeniedError extends Error {
  constructor(reason: string) {
    super(`Break-glass support access denied: ${reason}`);
    this.name = "BreakGlassSupportAccessDeniedError";
  }
}

/**
 * OS-V1-09 (Observability / Support / Break-Glass). AA-005 REV209: "expose
 * org/worker/connection health, approvals, incidents, cost/quota, audit/
 * evidence and recovery. Break-glass is scoped, time-bounded, reasoned/
 * consented where required and audited. Witness foreign-org visibility,
 * expired support access, unaudited access and UNKNOWN shown as success."
 *
 * Reuse-first: the "expose ... health/approvals/incidents/cost-quota/
 * audit-evidence/recovery" half is ALREADY closed verbatim by
 * `operational-observability-view.ts`'s own `composeOperationalObservabilityView`
 * (OS-V0-12) - task/worker health, connection/kill-switch state, quota read
 * model, pending approvals, and audit/evidence are all already real,
 * honestly-composed fields there; "recovery" is `TaskObservability`'s own
 * `workerHealth`/`pendingControlRequest` plus the `CHECKPOINTED` <->
 * `RUNNING` resume path OS-V1-07 already certified; "org health" is
 * `Organization.state` itself (`organization.ts`, OS-V0-01/V1-01),
 * already a real field - never duplicated here. A repository-wide
 * inspection before this task found ZERO existing break-glass/support-
 * access concept anywhere (confirmed by grep) - OS-V1-05's own exec-plan
 * explicitly deferred it to this task by name. This module is that
 * genuinely NEW-MINIMUM primitive: the admission gate a support principal
 * must pass BEFORE any existing observability composition is ever
 * assembled for a tenant other than their own.
 */

export type BreakGlassSupportViewKind = "TASK" | "CONNECTION" | "QUOTA" | "APPROVALS" | "AUDIT_EVIDENCE";

const RECOGNIZED_VIEW_KINDS: ReadonlySet<string> = new Set<string>(["TASK", "CONNECTION", "QUOTA", "APPROVALS", "AUDIT_EVIDENCE"]);

function isRecognizedViewKind(value: unknown): value is BreakGlassSupportViewKind {
  return typeof value === "string" && RECOGNIZED_VIEW_KINDS.has(value);
}

export type BreakGlassAccessGrantState = "ACTIVE" | "REVOKED";

/**
 * "Scoped": `scope` names exactly which observability view kinds this
 * grant admits - never "all of it." "Time-bounded": `expiresAt` is
 * mandatory, never optional (unlike `DelegatedAccessGrant`'s own
 * precedent, which this module otherwise mirrors, a break-glass grant can
 * never be open-ended). "Reasoned": `reason` is mandatory and non-empty.
 * "Consented where required": `consentRequired` names whether a fresh,
 * per-SESSION `consentRef` must be supplied at `authorizeBreakGlassSupportAccess`
 * time (never satisfied by anything recorded once, at mint time, on the
 * grant itself - consent for a real support session is a per-session
 * fact, not a standing one).
 */
export interface BreakGlassAccessGrant {
  readonly grantId: string;
  readonly supportTenantId: TenantScope["tenantId"];
  readonly targetTenantId: TenantScope["tenantId"];
  readonly grantedToRef: string;
  readonly grantedByRef: string;
  readonly reason: string;
  readonly scope: ReadonlyArray<BreakGlassSupportViewKind>;
  readonly consentRequired: boolean;
  readonly expiresAt: string;
  readonly state: BreakGlassAccessGrantState;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidBreakGlassAccessGrantError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidBreakGlassAccessGrantError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

/**
 * "Never born admitted" discipline, adapted: a grant IS the admission act
 * (mirroring `DelegatedAccessGrant`'s own precedent, which this module
 * otherwise follows) - it is born `ACTIVE`, but `expiresAt` is MANDATORY
 * (never optional) and `scope` must be a non-empty array of recognized
 * view kinds - a grant naming zero view kinds would admit nothing and is
 * rejected as a malformed grant, not silently accepted as a no-op.
 */
export function createBreakGlassAccessGrant(input: {
  grantId: unknown;
  supportTenantScope: TenantScope;
  targetTenantScope: TenantScope;
  grantedToRef: unknown;
  grantedByRef: unknown;
  reason: unknown;
  scope: ReadonlyArray<unknown>;
  consentRequired: unknown;
  expiresAt: unknown;
}): BreakGlassAccessGrant {
  const grantId = requireNonEmptyString(input.grantId, "grantId");
  const grantedToRef = requireNonEmptyString(input.grantedToRef, "grantedToRef");
  const grantedByRef = requireNonEmptyString(input.grantedByRef, "grantedByRef");
  const reason = requireNonEmptyString(input.reason, "reason");
  const expiresAt = requireValidTimestamp(input.expiresAt, "expiresAt");
  if (!Array.isArray(input.scope) || input.scope.length === 0 || !input.scope.every(isRecognizedViewKind)) {
    throw new InvalidBreakGlassAccessGrantError(
      "scope must be a non-empty array of recognized view kinds (TASK, CONNECTION, QUOTA, APPROVALS, AUDIT_EVIDENCE)",
    );
  }
  if (typeof input.consentRequired !== "boolean") {
    throw new InvalidBreakGlassAccessGrantError("consentRequired must be a boolean - never inferred");
  }
  return {
    grantId,
    supportTenantId: input.supportTenantScope.tenantId,
    targetTenantId: input.targetTenantScope.tenantId,
    grantedToRef,
    grantedByRef,
    reason,
    scope: input.scope as ReadonlyArray<BreakGlassSupportViewKind>,
    consentRequired: input.consentRequired,
    expiresAt,
    state: "ACTIVE",
  };
}

export function revokeBreakGlassAccessGrant(input: {
  grant: BreakGlassAccessGrant;
  revokedAt: unknown;
  revokedReason: unknown;
}): BreakGlassAccessGrant {
  if (input.grant.state === "REVOKED") {
    throw new InvalidBreakGlassAccessGrantError("grant is already REVOKED");
  }
  return {
    ...input.grant,
    state: "REVOKED",
    revokedAt: requireValidTimestamp(input.revokedAt, "revokedAt"),
    revokedReason: requireNonEmptyString(input.revokedReason, "revokedReason"),
  };
}

/**
 * Fails closed (never throws - a caller-facing pure predicate, mirroring
 * `isStaffSessionContextActive`/`isDelegatedAccessGrantActive`): `REVOKED`
 * or past `expiresAt` (strictly, at-or-after) is never active.
 */
export function isBreakGlassAccessGrantActive(grant: BreakGlassAccessGrant, now: string): boolean {
  if (grant.state === "REVOKED") {
    return false;
  }
  return Date.parse(now) < Date.parse(grant.expiresAt);
}

/**
 * Mandatory, non-optional audit evidence on every GRANTED result -
 * mirroring `ProtectedDecisionResumeAuthorization`'s own mandatory
 * `decisionEvidenceRef`/`resolvedAt` discipline exactly. There is no
 * code path in `authorizeBreakGlassSupportAccess` that can produce a
 * `GRANTED` result without this evidence - "unaudited access" is
 * structurally impossible, not merely checked.
 */
export interface BreakGlassSupportAccessAudit {
  readonly auditRef: string;
  readonly grantId: string;
  readonly supportTenantId: TenantScope["tenantId"];
  readonly targetTenantId: TenantScope["tenantId"];
  readonly requestedView: BreakGlassSupportViewKind;
  readonly decidedByPrincipalRef: string;
  readonly decidedAt: string;
}

export type BreakGlassSupportAccessDecision =
  | { readonly outcome: "GRANTED"; readonly audit: BreakGlassSupportAccessAudit }
  | { readonly outcome: "DENIED"; readonly reason: string };

/**
 * The one admission gate. Fails closed (never throws for an ordinary
 * denial - returns `DENIED` with a reason, mirroring `resolveWorkerRoute`'s
 * own "a policy outcome is never a thrown error" discipline) on: a grant
 * that targets a different tenant than `targetTenantScope` ("foreign-org
 * visibility" - a grant for org A can never be presented to view org B);
 * a grant that is `REVOKED` or past `expiresAt` ("expired support
 * access"); `currentPrincipalRef` not exactly matching `grant.grantedToRef`
 * (mirrors OS-V1-02's own authenticated-delegated-access discipline - a
 * grant can never be exercised by anyone other than who it was issued
 * to, regardless of who presents it); `requestedView` outside
 * `grant.scope` ("scoped"); and `grant.consentRequired` with no
 * caller-supplied `consentRef` for THIS call ("consented where required"
 * - never satisfied by a standing fact recorded once on the grant
 * itself).
 *
 * `auditRef` is caller-supplied (this module never invents audit-log
 * identity) but its PRESENCE on every granted decision is enforced here,
 * never left to the caller to remember.
 */
export function authorizeBreakGlassSupportAccess(input: {
  grant: BreakGlassAccessGrant;
  targetTenantScope: TenantScope;
  currentPrincipalRef: unknown;
  requestedView: unknown;
  consentRef?: unknown;
  auditRef: unknown;
  now: unknown;
}): BreakGlassSupportAccessDecision {
  if (input.grant.targetTenantId !== input.targetTenantScope.tenantId) {
    return { outcome: "DENIED", reason: "grant does not target the requested tenant - foreign-org visibility is never permitted on a mismatched grant" };
  }
  if (!isBreakGlassAccessGrantActive(input.grant, typeof input.now === "string" ? input.now : "")) {
    return { outcome: "DENIED", reason: "grant is REVOKED or has expired" };
  }
  const currentPrincipalRef = typeof input.currentPrincipalRef === "string" ? input.currentPrincipalRef : "";
  if (currentPrincipalRef.length === 0 || currentPrincipalRef !== input.grant.grantedToRef) {
    return { outcome: "DENIED", reason: "currentPrincipalRef does not match the authenticated principal this grant was issued to" };
  }
  if (!isRecognizedViewKind(input.requestedView) || !input.grant.scope.includes(input.requestedView)) {
    return { outcome: "DENIED", reason: `requestedView is outside this grant's own scope (${input.grant.scope.join(", ")})` };
  }
  if (input.grant.consentRequired && (typeof input.consentRef !== "string" || input.consentRef.trim().length === 0)) {
    return { outcome: "DENIED", reason: "this grant requires a fresh, per-session consentRef, which was not supplied" };
  }
  const auditRef = requireNonEmptyString(input.auditRef, "auditRef");
  const decidedAt = requireValidTimestamp(input.now, "now");
  return {
    outcome: "GRANTED",
    audit: {
      auditRef,
      grantId: input.grant.grantId,
      supportTenantId: input.grant.supportTenantId,
      targetTenantId: input.grant.targetTenantId,
      requestedView: input.requestedView,
      decidedByPrincipalRef: currentPrincipalRef,
      decidedAt,
    },
  };
}
