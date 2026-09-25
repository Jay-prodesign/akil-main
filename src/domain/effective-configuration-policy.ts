import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Project } from "./project.js";

export class InvalidEffectiveConfigurationPolicyError extends Error {
  constructor(reason: string) {
    super(`Invalid effective configuration/policy resolution: ${reason}`);
    this.name = "InvalidEffectiveConfigurationPolicyError";
  }
}

export type EffectiveControlKind = "CONFIG" | "POLICY";

/**
 * OS-V0-04 Phase A: the precedence chain Rev141 specifies - Platform floor
 * -> Organization -> retained Customer scope -> Project -> Job/Task bounded
 * preference -> exact-action preference/approval context. A HIGHER index
 * wins over a LOWER index for an ordinary (non-protected-floor) control of
 * the same `kind`+`key`; a `PLATFORM` control marked `protectedFloor` can
 * never be overridden regardless of index, per Rev141's explicit
 * non-weakenable-floor requirement.
 */
export type EffectiveControlScope = "PLATFORM" | "ORGANIZATION" | "CUSTOMER" | "PROJECT" | "JOB" | "ACTION";

const SCOPE_PRECEDENCE: Readonly<Record<EffectiveControlScope, number>> = {
  PLATFORM: 0,
  ORGANIZATION: 1,
  CUSTOMER: 2,
  PROJECT: 3,
  JOB: 4,
  ACTION: 5,
};

const VALID_SCOPES: ReadonlySet<string> = new Set(Object.keys(SCOPE_PRECEDENCE));

/**
 * `ACTION` scope here is configuration/policy resolution provenance only -
 * deliberately NOT execution approval, permission, entitlement, or
 * protected-effect authority. This module has no dependency on
 * `authority.ts`/`approval-reference.ts` and must never gain one; a lower
 * layer selecting an `ACTION`-scope control changes which config/policy ref
 * is effective, never whether an action is authorized.
 */
export interface ScopedControlIdentity {
  readonly tenantId?: TenantScope["tenantId"];
  readonly customerId?: Customer["customerId"];
  readonly projectId?: Project["projectId"];
  readonly jobId?: string;
  readonly actionRef?: string;
}

export interface EffectiveConfigurationPolicyRequest {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId?: Customer["customerId"];
  readonly projectId?: Project["projectId"];
  readonly jobId?: string;
  readonly actionRef?: string;
  readonly controls: ReadonlyArray<unknown>;
}

export interface EffectiveControl {
  readonly kind: EffectiveControlKind;
  readonly key: string;
  readonly scope: EffectiveControlScope;
  readonly sourceRef: string;
  readonly version: string;
  readonly protectedFloor: boolean;
}

export interface EffectiveConfigurationPolicyResolution {
  readonly effectiveConfigRefs: ReadonlyArray<string>;
  readonly effectivePolicyRefs: ReadonlyArray<string>;
  readonly effectiveControls: ReadonlyArray<EffectiveControl>;
}

interface ValidatedControl {
  readonly kind: EffectiveControlKind;
  readonly key: string;
  readonly scope: EffectiveControlScope;
  readonly sourceRef: string;
  readonly version: string;
  readonly protectedFloor: boolean;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidEffectiveConfigurationPolicyError(`${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new InvalidEffectiveConfigurationPolicyError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidEffectiveConfigurationPolicyError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireOptionalNonEmptyString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, field);
}

/**
 * Fail-closed scope correlation (Rev141 A7-A10): a control's own supplied
 * identity must carry EXACTLY the identity fields its scope requires, each
 * equal to the requesting context's own value - never inferred, never
 * partially checked, never silently ignored. A control claiming a scope
 * deeper than the requesting context actually supplies (e.g. a `JOB`
 * control when the request carries no `jobId`) fails closed rather than
 * being treated as inapplicable.
 */
function requireCorrelatedIdentity(
  scope: EffectiveControlScope,
  identity: ScopedControlIdentity,
  request: EffectiveConfigurationPolicyRequest,
  index: number,
): void {
  const label = `controls[${index}]`;
  const requiredFields: ReadonlyArray<keyof ScopedControlIdentity> =
    scope === "PLATFORM"
      ? []
      : scope === "ORGANIZATION"
        ? ["tenantId"]
        : scope === "CUSTOMER"
          ? ["tenantId", "customerId"]
          : scope === "PROJECT"
            ? ["tenantId", "customerId", "projectId"]
            : scope === "JOB"
              ? ["tenantId", "customerId", "projectId", "jobId"]
              : ["tenantId", "customerId", "projectId", "jobId", "actionRef"];
  const allFields: ReadonlyArray<keyof ScopedControlIdentity> = [
    "tenantId",
    "customerId",
    "projectId",
    "jobId",
    "actionRef",
  ];

  for (const field of allFields) {
    const required = requiredFields.includes(field);
    const suppliedRaw = identity[field];
    if (!required) {
      if (suppliedRaw !== undefined) {
        throw new InvalidEffectiveConfigurationPolicyError(
          `${label}: a ${scope} control must not supply identity.${field}`,
        );
      }
      continue;
    }
    const supplied = requireOptionalNonEmptyString(suppliedRaw, `${label}.identity.${field}`);
    if (supplied === undefined) {
      throw new InvalidEffectiveConfigurationPolicyError(
        `${label}: a ${scope} control requires identity.${field}`,
      );
    }
    const requestValue = request[field];
    if (requestValue === undefined) {
      throw new InvalidEffectiveConfigurationPolicyError(
        `${label}: a ${scope} control requires the request to supply ${field}, but none was given`,
      );
    }
    if (supplied !== requestValue) {
      throw new InvalidEffectiveConfigurationPolicyError(
        `${label}: identity.${field} ("${supplied}") does not match the requesting context's ${field} ("${requestValue}") - scope correlation failed closed`,
      );
    }
  }
}

function validateControl(
  raw: unknown,
  request: EffectiveConfigurationPolicyRequest,
  index: number,
): ValidatedControl {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidEffectiveConfigurationPolicyError(`controls[${index}] must be an object`);
  }
  const candidate = raw as Record<string, unknown>;

  if (candidate.kind !== "CONFIG" && candidate.kind !== "POLICY") {
    throw new InvalidEffectiveConfigurationPolicyError(
      `controls[${index}].kind must be "CONFIG" or "POLICY"`,
    );
  }
  const kind = candidate.kind;

  if (typeof candidate.scope !== "string" || !VALID_SCOPES.has(candidate.scope)) {
    throw new InvalidEffectiveConfigurationPolicyError(
      `controls[${index}].scope must be one of PLATFORM, ORGANIZATION, CUSTOMER, PROJECT, JOB, ACTION`,
    );
  }
  const scope = candidate.scope as EffectiveControlScope;

  const key = requireNonEmptyString(candidate.key, `controls[${index}].key`);
  const sourceRef = requireNonEmptyString(candidate.sourceRef, `controls[${index}].sourceRef`);
  const version = requireNonEmptyString(candidate.version, `controls[${index}].version`);

  let protectedFloor = false;
  if (candidate.protectedFloor !== undefined) {
    if (typeof candidate.protectedFloor !== "boolean") {
      throw new InvalidEffectiveConfigurationPolicyError(
        `controls[${index}].protectedFloor must be a boolean when supplied`,
      );
    }
    protectedFloor = candidate.protectedFloor;
    if (protectedFloor && scope !== "PLATFORM") {
      throw new InvalidEffectiveConfigurationPolicyError(
        `controls[${index}]: protectedFloor may only be true on a PLATFORM-scope control`,
      );
    }
  }

  const rawIdentity = candidate.identity;
  if (typeof rawIdentity !== "object" || rawIdentity === null || Array.isArray(rawIdentity)) {
    throw new InvalidEffectiveConfigurationPolicyError(`controls[${index}].identity must be an object`);
  }
  requireCorrelatedIdentity(scope, rawIdentity as ScopedControlIdentity, request, index);

  return { kind, key, scope, sourceRef, version, protectedFloor };
}

function effectiveRef(control: ValidatedControl): string {
  return `${control.key}@${control.version}#${control.sourceRef}`;
}

/**
 * Pure, deterministic resolver: no persistence, database, provider/model
 * call, clock read, randomness, or new dependency. Selects, for every
 * distinct `kind`+`key`, the single highest-precedence control among the
 * caller-supplied layers - unless a `PLATFORM` layer for that `kind`+`key`
 * is `protectedFloor`, in which case that floor is the only ever-valid
 * answer and any attempted override at another scope fails closed rather
 * than being silently discarded (Rev141: "protected higher floor
 * non-weakenable").
 */
export function resolveEffectiveConfigurationPolicy(
  request: EffectiveConfigurationPolicyRequest,
): EffectiveConfigurationPolicyResolution {
  requireNonEmptyString(request.tenantId, "tenantId");
  if (request.actionRef !== undefined && request.jobId === undefined) {
    throw new InvalidEffectiveConfigurationPolicyError(
      "an actionRef request context requires jobId to also be supplied",
    );
  }

  const validated = request.controls.map((raw, index) => validateControl(raw, request, index));

  // A6: same kind+key within the same scope (== the same effective layer,
  // since every accepted control already correlates to this single
  // request's own identity) is ambiguous and fails closed.
  const scopeSeen = new Set<string>();
  for (const control of validated) {
    const scopeKey = `${control.kind}::${control.scope}::${control.key}`;
    if (scopeSeen.has(scopeKey)) {
      throw new InvalidEffectiveConfigurationPolicyError(
        `duplicate ${control.kind} key "${control.key}" supplied more than once at scope ${control.scope}`,
      );
    }
    scopeSeen.add(scopeKey);
  }

  const byKey = new Map<string, ValidatedControl[]>();
  for (const control of validated) {
    const groupKey = `${control.kind}::${control.key}`;
    const group = byKey.get(groupKey);
    if (group === undefined) {
      byKey.set(groupKey, [control]);
    } else {
      group.push(control);
    }
  }

  const winners: ValidatedControl[] = [];
  for (const group of byKey.values()) {
    const protectedFloorEntry = group.find((c) => c.scope === "PLATFORM" && c.protectedFloor);
    if (protectedFloorEntry !== undefined) {
      const violator = group.find((c) => c !== protectedFloorEntry);
      if (violator !== undefined) {
        throw new InvalidEffectiveConfigurationPolicyError(
          `${violator.kind} key "${violator.key}" has a PROTECTED_FLOOR PLATFORM control and cannot be overridden by a ${violator.scope}-scope control`,
        );
      }
      winners.push(protectedFloorEntry);
      continue;
    }
    let winner = group[0]!;
    for (const candidate of group) {
      if (SCOPE_PRECEDENCE[candidate.scope] > SCOPE_PRECEDENCE[winner.scope]) {
        winner = candidate;
      }
    }
    winners.push(winner);
  }

  // A5: deterministic ordering independent of caller array order.
  winners.sort((a, b) => (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind.localeCompare(b.kind)));

  const effectiveControls: EffectiveControl[] = winners.map((control) => ({
    kind: control.kind,
    key: control.key,
    scope: control.scope,
    sourceRef: control.sourceRef,
    version: control.version,
    protectedFloor: control.protectedFloor,
  }));

  const effectiveConfigRefs = winners
    .filter((c) => c.kind === "CONFIG")
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(effectiveRef);
  const effectivePolicyRefs = winners
    .filter((c) => c.kind === "POLICY")
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(effectiveRef);

  return { effectiveConfigRefs, effectivePolicyRefs, effectiveControls };
}
