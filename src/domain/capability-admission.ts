import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { RequirementId } from "./offer-blueprint.js";
import type { ConnectionBinding, ConnectionRequirement } from "./connection-authority.js";

export class InvalidCapabilityAdmissionError extends Error {
  constructor(reason: string) {
    super(`Invalid CapabilityAdmission: ${reason}`);
    this.name = "InvalidCapabilityAdmissionError";
  }
}

type CapabilityAdmissionId = string & { readonly __brand: "CapabilityAdmissionId" };

/**
 * V2-CDO-004 "Provider-neutral capability admission/availability
 * observation" (IN SCOPE #6). `UNVERIFIED` is the only status that never
 * implies a compatible connection exists; `VERIFIED_AVAILABLE` is the
 * only status a caller may promote to, and only through this module's
 * own construction-time gate below (C8/C9: there is no separate
 * "promote" function, and this module imports no `OutcomeJob`/
 * `ProjectPlanVersion` transition/verification function - see the
 * V2-CDO-004 boundary scan).
 */
export type CapabilityAdmissionStatus =
  | "UNVERIFIED"
  | "VERIFIED_AVAILABLE"
  | "UNSUPPORTED"
  | "INELIGIBLE";

const CAPABILITY_ADMISSION_STATUS_VALUES: ReadonlySet<string> = new Set([
  "UNVERIFIED",
  "VERIFIED_AVAILABLE",
  "UNSUPPORTED",
  "INELIGIBLE",
]);

/**
 * `connectionBindingId` is present only when a `ConnectionBinding` was
 * actually evaluated for this observation (required for
 * `VERIFIED_AVAILABLE`; optional context for the other statuses, e.g.
 * "this exact binding was checked and found `UNSUPPORTED`").
 * `evidenceRef` is required for `VERIFIED_AVAILABLE` (C8) and otherwise
 * optional context - this is a readiness/consumption-authority record
 * only; it has no field or function that can execute a provider action,
 * approve work, or transition an `OutcomeJob`/`ProjectPlanVersion` (C9).
 */
export interface CapabilityAdmission {
  readonly capabilityAdmissionId: CapabilityAdmissionId;
  readonly ownership: ProjectOwnershipRef;
  readonly requiredCapabilityRef: RequirementId;
  readonly status: CapabilityAdmissionStatus;
  readonly connectionBindingId?: ConnectionBinding["connectionBindingId"];
  readonly evidenceRef?: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidCapabilityAdmissionError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidCapabilityAdmissionError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidCapabilityAdmissionError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidCapabilityAdmissionError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function ownershipEquals(a: ProjectOwnershipRef, b: ProjectOwnershipRef): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.projectId === b.projectId &&
    a.serviceRef === b.serviceRef
  );
}

/**
 * C8/C9: `VERIFIED_AVAILABLE` requires an explicit `binding` argument
 * whose `connectionState` is already `"VERIFIED"` (constructed via
 * `verifyConnectionBinding` - `connection-authority.ts` remains the sole
 * authority for that state), whose ownership tuple exactly matches this
 * observation's `ownership` (fail-closed cross-tenant/cross-project
 * binding, same pattern as `project-communication.ts` O6), plus a
 * non-empty `evidenceRef`.
 *
 * CR-1 (Brain checkpoint 7b48fdc, capability/binding compatibility):
 * `ConnectionBinding` carries only an opaque `connectionRequirementId`,
 * not the capability it actually satisfies - so `binding` alone can
 * never prove which capability it belongs to. `VERIFIED_AVAILABLE`
 * therefore also requires the caller to supply the exact
 * `ConnectionRequirement` the binding was constructed against, and this
 * function proves two things transitively rather than trusting either
 * value alone: (a) `requirement.requiredCapabilityRef` equals this
 * observation's `requiredCapabilityRef` (the requirement is actually for
 * the capability being admitted), and (b)
 * `binding.connectionRequirementId` equals
 * `requirement.connectionRequirementId` (the binding was actually issued
 * against that exact requirement, not merely some other same-ownership
 * one). Without both checks, a VERIFIED binding for capability A could be
 * reused to admit capability B under the same ownership tuple.
 * `UNVERIFIED`/`UNSUPPORTED`/`INELIGIBLE` never require any of this and
 * can never be silently promoted: this is the only construction function
 * in the module, there is no separate mutation/promotion path.
 */
export function createCapabilityAdmission(input: {
  capabilityAdmissionId: unknown;
  ownership: ProjectOwnershipRef;
  requiredCapabilityRef: unknown;
  status: unknown;
  binding?: ConnectionBinding;
  requirement?: ConnectionRequirement;
  evidenceRef?: unknown;
}): CapabilityAdmission {
  const capabilityAdmissionId = requireNonEmptyString(
    input.capabilityAdmissionId,
    "capabilityAdmissionId",
  );
  const requiredCapabilityRef = requireNonEmptyString(
    input.requiredCapabilityRef,
    "requiredCapabilityRef",
  );
  if (
    typeof input.status !== "string" ||
    !CAPABILITY_ADMISSION_STATUS_VALUES.has(input.status)
  ) {
    throw new InvalidCapabilityAdmissionError(
      'status must be one of "UNVERIFIED", "VERIFIED_AVAILABLE", "UNSUPPORTED", "INELIGIBLE"',
    );
  }
  const status = input.status as CapabilityAdmissionStatus;

  if (input.binding !== undefined) {
    if (!ownershipEquals(input.binding.ownership, input.ownership)) {
      throw new InvalidCapabilityAdmissionError(
        "binding does not belong to the given ownership tuple",
      );
    }
  }

  if (status === "VERIFIED_AVAILABLE") {
    if (input.binding === undefined) {
      throw new InvalidCapabilityAdmissionError(
        "VERIFIED_AVAILABLE requires a compatible VERIFIED ConnectionBinding",
      );
    }
    if (input.requirement === undefined) {
      throw new InvalidCapabilityAdmissionError(
        "VERIFIED_AVAILABLE requires the ConnectionRequirement the binding was issued against, to prove capability compatibility",
      );
    }
    if (input.requirement.requiredCapabilityRef !== requiredCapabilityRef) {
      throw new InvalidCapabilityAdmissionError(
        "VERIFIED_AVAILABLE requires the given requirement's requiredCapabilityRef to match this observation's requiredCapabilityRef",
      );
    }
    if (input.binding.connectionRequirementId !== input.requirement.connectionRequirementId) {
      throw new InvalidCapabilityAdmissionError(
        "VERIFIED_AVAILABLE requires the given binding to have been issued against the given requirement",
      );
    }
    if (input.binding.connectionState !== "VERIFIED") {
      throw new InvalidCapabilityAdmissionError(
        "VERIFIED_AVAILABLE requires the given binding's connectionState to be VERIFIED",
      );
    }
    if (input.evidenceRef === undefined) {
      throw new InvalidCapabilityAdmissionError(
        "VERIFIED_AVAILABLE requires a non-empty evidenceRef",
      );
    }
    const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
    return {
      capabilityAdmissionId: capabilityAdmissionId as CapabilityAdmissionId,
      ownership: input.ownership,
      requiredCapabilityRef: requiredCapabilityRef as RequirementId,
      status,
      connectionBindingId: input.binding.connectionBindingId,
      evidenceRef,
    };
  }

  const base = {
    capabilityAdmissionId: capabilityAdmissionId as CapabilityAdmissionId,
    ownership: input.ownership,
    requiredCapabilityRef: requiredCapabilityRef as RequirementId,
    status,
    ...(input.binding !== undefined
      ? { connectionBindingId: input.binding.connectionBindingId }
      : {}),
  };
  if (input.evidenceRef === undefined) {
    return base;
  }
  const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  return { ...base, evidenceRef };
}
