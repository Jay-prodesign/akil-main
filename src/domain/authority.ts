import type { TenantScope } from "./tenant-scope.js";

export type Permission = "READ" | "WRITE" | "EXECUTE";

export class InvalidAuthorityContextError extends Error {
  constructor(reason: string) {
    super(`Invalid AuthorityContext: ${reason}`);
    this.name = "InvalidAuthorityContextError";
  }
}

export class InsufficientAuthorityError extends Error {
  constructor(required: Permission, granted: ReadonlySet<Permission>) {
    super(
      `Requires ${required} permission; granted: [${[...granted].join(", ")}]`,
    );
    this.name = "InsufficientAuthorityError";
  }
}

export class ProtectedActionNotAuthorizedError extends Error {
  constructor(action: string) {
    super(
      `Protected action "${action}" requires explicit protected-action authorization`,
    );
    this.name = "ProtectedActionNotAuthorizedError";
  }
}

/**
 * T2 / EI-4 (structural tenant scope, P0): an AuthorityContext for
 * tenant A must never authorize an operation on a tenant B record, no
 * matter what permissions it holds. Found missing during the step 8/9
 * coverage audit - the application-boundary wrappers previously checked
 * only permissions, never tenant correlation.
 */
export class CrossTenantAuthorityError extends Error {
  constructor() {
    super(
      "AuthorityContext's tenant does not match the target record's tenant",
    );
    this.name = "CrossTenantAuthorityError";
  }
}

const VALID_PERMISSIONS: ReadonlySet<string> = new Set([
  "READ",
  "WRITE",
  "EXECUTE",
]);

/**
 * Minimum security/authority contract (AKI-BE-001 execution record,
 * "Minimum Security / Authority Contract"): permission semantics support
 * at least READ/WRITE/EXECUTE and protected-action classification,
 * without a full IAM product. This is a caller-supplied, application-
 * boundary authority context - not identity/session resolution. No
 * agent/model/provider has direct database or authorization authority;
 * this module does not resolve "who is calling" from anywhere (that
 * remains a future, explicit integration), it only checks permissions
 * already present on the context it is given.
 */
export interface AuthorityContext {
  readonly tenantId: TenantScope["tenantId"];
  readonly permissions: ReadonlySet<Permission>;
  readonly canPerformProtectedActions: boolean;
}

export function createAuthorityContext(input: {
  tenantScope: TenantScope;
  permissions: Iterable<unknown>;
  canPerformProtectedActions: unknown;
}): AuthorityContext {
  const permissions = new Set<Permission>();
  for (const permission of input.permissions) {
    if (typeof permission !== "string" || !VALID_PERMISSIONS.has(permission)) {
      throw new InvalidAuthorityContextError(
        `permissions must only contain "READ", "WRITE", or "EXECUTE"; got ${JSON.stringify(permission)}`,
      );
    }
    permissions.add(permission as Permission);
  }
  if (typeof input.canPerformProtectedActions !== "boolean") {
    throw new InvalidAuthorityContextError(
      "canPerformProtectedActions must be a boolean",
    );
  }
  return {
    tenantId: input.tenantScope.tenantId,
    permissions,
    canPerformProtectedActions: input.canPerformProtectedActions,
  };
}

/**
 * T2 / EI-4: an AuthorityContext may only be used against records in
 * its own tenant. Structural, checked before any permission check -
 * a mismatched tenant fails closed regardless of what permissions the
 * context holds.
 */
export function requireSameTenant(
  authority: AuthorityContext,
  tenantId: TenantScope["tenantId"],
): void {
  if (authority.tenantId !== tenantId) {
    throw new CrossTenantAuthorityError();
  }
}

/**
 * T8: READ-only authority cannot perform WRITE/EXECUTE behavior. Checks
 * only `authority.permissions` - nothing about the operation's inputs
 * (job content, business text, etc.) can influence this decision
 * (RG-05: changing input/model text cannot grant higher authority).
 */
export function requirePermission(
  authority: AuthorityContext,
  required: Permission,
): void {
  if (!authority.permissions.has(required)) {
    throw new InsufficientAuthorityError(required, authority.permissions);
  }
}

/**
 * T9: a protected action cannot be silently treated as an ordinary
 * low-risk write/execute. Having EXECUTE is not sufficient on its own -
 * `canPerformProtectedActions` must be explicitly true.
 */
export function requireProtectedActionAuthorization(
  authority: AuthorityContext,
  action: string,
): void {
  if (!authority.canPerformProtectedActions) {
    throw new ProtectedActionNotAuthorizedError(action);
  }
}
