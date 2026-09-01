import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { CapabilityAdmission } from "./capability-admission.js";

export class InvalidServiceCapabilityRouteError extends Error {
  constructor(reason: string) {
    super(`Invalid ServiceCapabilityRoute: ${reason}`);
    this.name = "InvalidServiceCapabilityRouteError";
  }
}

/**
 * V4 Full Blueprint §5, Workstream A, spine item B - depends directly on
 * the existing V2-CDO-004 `CapabilityAdmission`/`CapabilityAdmissionStatus`,
 * extended rather than duplicated ("reusable Delivery Recipe/capability
 * semantics from V2 are extended rather than duplicated," §5). "Capability
 * states may include UNAVAILABLE / MANUAL / PROVIDER_NATIVE /
 * ENGINEER_ASSISTED / READ_ONLY / DIAGNOSE / RECOMMEND / DRAFT_PREVIEW /
 * APPROVAL_REQUIRED / CONTROLLED_APPLY equivalents." No real provider
 * adapter (read, diagnose, recommend, draft, apply) exists anywhere in
 * this repository yet - V4 §7 Workstream C, "Service-Specific Control
 * Adapters," is not started - so this module can only ever honestly
 * resolve two rungs: `UNAVAILABLE` (no verified capability admission) and
 * `READ_ONLY` (a verified capability admission exists - see
 * `resolveServiceCapabilityRoute` below - but nothing beyond passive
 * observation has been built). The remaining eight literals are declared
 * so a future real adapter (Workstream C) can produce them, but are not
 * yet producible by this slice - same "declared, not yet producible"
 * discipline already established by `AssignmentStatus` (V3-ORG-001) and
 * `DiscountAuthorityLevel` (V3-COM-001).
 */
export type ExecutionMaturity =
  | "UNAVAILABLE"
  | "MANUAL"
  | "PROVIDER_NATIVE"
  | "ENGINEER_ASSISTED"
  | "READ_ONLY"
  | "DIAGNOSE"
  | "RECOMMEND"
  | "DRAFT_PREVIEW"
  | "APPROVAL_REQUIRED"
  | "CONTROLLED_APPLY";

/**
 * §5: "service/customer outcome, required capability, admitted
 * capability, provider support, entitlement, delegated authority and
 * execution maturity are separate dimensions." This bounded slice
 * represents only two of those seven dimensions from real repo data:
 * the required capability reference (reused verbatim from the existing
 * `CapabilityAdmission.requiredCapabilityRef`) and its resolved
 * execution maturity. `serviceFamilyRef` is a caller-supplied label for
 * the customer/service outcome being routed - it is not validated
 * against a canonical service catalog because none exists in this
 * repository yet; it is carried through for provenance only. Provider
 * support, entitlement and delegated authority beyond the existing
 * `CapabilityAdmission` observation are explicitly NOT represented here
 * - see the exec-plan's "Explicitly deferred" section for why.
 */
export interface ServiceCapabilityRoute {
  readonly tenantId: ProjectOwnershipRef["tenantId"];
  readonly customerId: ProjectOwnershipRef["customerId"];
  readonly projectId: ProjectOwnershipRef["projectId"];
  readonly serviceFamilyRef: string;
  readonly requiredCapabilityRef: CapabilityAdmission["requiredCapabilityRef"];
  readonly executionMaturity: ExecutionMaturity;
  readonly reason: string;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidServiceCapabilityRouteError(`${field} must be a string`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new InvalidServiceCapabilityRouteError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidServiceCapabilityRouteError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

/**
 * §5 acceptance direction: "mismatched capability/provider/tenant
 * references reject" - the given `admission`'s ownership must exactly
 * match the given `ownership` scope, or construction rejects.
 *
 * §5 acceptance direction: "route recommendation cannot grant
 * authority; unsupported capabilities stay unsupported; stale admission
 * state cannot appear as current executable support." This function
 * exports no mutation/promotion path - it only reads an already-resolved
 * `CapabilityAdmission` (V2-CDO-004 remains the sole authority for that
 * state) and honestly caps the resulting `executionMaturity` at
 * `READ_ONLY`, never inferring `DIAGNOSE`/`RECOMMEND`/`APPROVAL_REQUIRED`/
 * `CONTROLLED_APPLY` from admission status alone. `UNVERIFIED`,
 * `UNSUPPORTED` and `INELIGIBLE` all resolve `UNAVAILABLE` - none of them
 * ever implies executable support (`UNSUPPORTED`/`INELIGIBLE` stay
 * unsupported by construction, not by a separate check). `reason` always
 * cites the exact admission status this decision was made from
 * (§5: "routing records provenance and reason where decisions are
 * material"). `CapabilityAdmission` carries no timestamp field in this
 * repository yet, so staleness detection is not representable here - a
 * disclosed gap, not a silent omission.
 */
export function resolveServiceCapabilityRoute(input: {
  ownership: ProjectOwnershipRef;
  serviceFamilyRef: unknown;
  admission: CapabilityAdmission;
}): ServiceCapabilityRoute {
  const serviceFamilyRef = requireNonEmptyString(input.serviceFamilyRef, "serviceFamilyRef");

  if (
    input.admission.ownership.tenantId !== input.ownership.tenantId ||
    input.admission.ownership.customerId !== input.ownership.customerId ||
    input.admission.ownership.projectId !== input.ownership.projectId
  ) {
    throw new InvalidServiceCapabilityRouteError(
      "admission does not belong to the given ownership scope",
    );
  }

  const base = {
    tenantId: input.ownership.tenantId,
    customerId: input.ownership.customerId,
    projectId: input.ownership.projectId,
    serviceFamilyRef,
    requiredCapabilityRef: input.admission.requiredCapabilityRef,
  };

  if (input.admission.status === "VERIFIED_AVAILABLE") {
    return {
      ...base,
      executionMaturity: "READ_ONLY",
      reason:
        "capability admission status is VERIFIED_AVAILABLE; capped at READ_ONLY because no adapter beyond passive observation exists yet",
    };
  }

  return {
    ...base,
    executionMaturity: "UNAVAILABLE",
    reason: `capability admission status is ${input.admission.status}, not VERIFIED_AVAILABLE`,
  };
}
