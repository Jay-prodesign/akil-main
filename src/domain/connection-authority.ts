import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { RequirementId } from "./offer-blueprint.js";

export class InvalidConnectionAuthorityError extends Error {
  constructor(reason: string) {
    super(`Invalid connection authority input: ${reason}`);
    this.name = "InvalidConnectionAuthorityError";
  }
}

export class InvalidConnectionTransitionError extends Error {
  constructor(from: ConnectionState, to: ConnectionState | "VERIFIED") {
    super(`Invalid ConnectionBinding transition: ${from} -> ${to}`);
    this.name = "InvalidConnectionTransitionError";
  }
}

type ConnectionRequirementId = string & { readonly __brand: "ConnectionRequirementId" };
type ConnectionBindingId = string & { readonly __brand: "ConnectionBindingId" };
type SecretRefId = string & { readonly __brand: "SecretRefId" };

/**
 * V2-CDO-004 "SecretRef" (IN SCOPE #3): an opaque stable reference
 * identifier only. No password, API key, token, recovery code, private
 * key, cookie, credential payload, encryption payload or vault secret
 * value may enter this contract - this type structurally has no field
 * capable of holding one; it is exactly one branded id.
 */
export interface SecretRef {
  readonly secretRefId: SecretRefId;
}

export type AccountOwnership = "CUSTOMER_OWNED" | "AKILTA_MANAGED";

/**
 * IN SCOPE #5. `VERIFIED` is reachable only through `verifyConnectionBinding`
 * (never through construction or the generic `transitionConnectionBinding`)
 * - the same structural separation `outcome-job.ts` uses to keep
 * "execution/tool success is not verification" (DEC-122 RG-04) from being
 * fakeable via a bare state assignment.
 */
export type ConnectionState =
  | "REQUESTED"
  | "CONNECTED_UNVERIFIED"
  | "VERIFIED"
  | "DEGRADED"
  | "REVOKED"
  | "HANDOVER_COMPLETE";

const ACCOUNT_OWNERSHIP_VALUES: ReadonlySet<string> = new Set(["CUSTOMER_OWNED", "AKILTA_MANAGED"]);

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidConnectionAuthorityError(`${field} must be a string`);
  }
  if (value.length === 0) {
    throw new InvalidConnectionAuthorityError(`${field} must not be empty`);
  }
  if (value.trim().length === 0) {
    throw new InvalidConnectionAuthorityError(`${field} must not be whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidConnectionAuthorityError(
      `${field} must not contain leading or trailing whitespace`,
    );
  }
  return value;
}

function requireStringArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new InvalidConnectionAuthorityError(`${field} must be an array`);
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${field}[${index}]`));
}

/**
 * O2/C2 (this task's numbering: C2): rejects empty/missing `secretRefId`.
 * No further shape is asserted about the reference - opacity is enforced
 * by this type having no other field, not by inspecting the string's
 * content.
 */
export function createSecretRef(input: { secretRefId: unknown }): SecretRef {
  const secretRefId = requireNonEmptyString(input.secretRefId, "secretRefId");
  return { secretRefId: secretRefId as SecretRefId };
}

/**
 * V2-CDO-004 "ConnectionRequirement" (IN SCOPE #1). Bound to the exact
 * V2-CDO-003 `ProjectOwnershipRef` tuple (C4: no cross-project/tenant
 * rebinding). `requiredCapabilityRef` reuses the existing `RequirementId`
 * branded type from `offer-blueprint.ts` (IN SCOPE #7 - "preserve
 * capability/integration references... otherwise... without inventing a
 * parallel planning lifecycle") rather than inventing a new capability
 * identifier: the `WEBSITE_BUILD_v1` blueprint (DEL-003) already declares
 * `required-access-connections` as exactly this kind of capability
 * reference ("Declare required external access/connections as versioned
 * ConnectionRequirement references (no raw credentials)"). `requiredByRef`
 * is the optional "required-by milestone/context" field (IN SCOPE #1) -
 * this repository has no canonical `Milestone` type to reuse, so it is a
 * plain optional `RequirementId` naming the downstream blueprint
 * requirement that consumes this connection (e.g.
 * `optional-ecommerce-integration`, which already `dependsOn:
 * ["required-access-connections"]` in the existing fixture).
 */
export interface ConnectionRequirement {
  readonly connectionRequirementId: ConnectionRequirementId;
  readonly ownership: ProjectOwnershipRef;
  readonly requiredCapabilityRef: RequirementId;
  readonly purpose: string;
  readonly requiredByRef?: RequirementId;
  readonly accountOwner: AccountOwnership;
  readonly minimumProviderScope: ReadonlyArray<string>;
  readonly connectionMethod: string;
  readonly validationRequirement: string;
}

/**
 * C2/C3: every stable ref is explicit and non-empty; account ownership
 * is explicit with no default inferred (an invalid/missing
 * `accountOwner` rejects rather than silently defaulting to either
 * classification).
 */
export function createConnectionRequirement(input: {
  connectionRequirementId: unknown;
  ownership: ProjectOwnershipRef;
  requiredCapabilityRef: unknown;
  purpose: unknown;
  requiredByRef?: unknown;
  accountOwner: unknown;
  minimumProviderScope: unknown;
  connectionMethod: unknown;
  validationRequirement: unknown;
}): ConnectionRequirement {
  const connectionRequirementId = requireNonEmptyString(
    input.connectionRequirementId,
    "connectionRequirementId",
  );
  const requiredCapabilityRef = requireNonEmptyString(
    input.requiredCapabilityRef,
    "requiredCapabilityRef",
  );
  const purpose = requireNonEmptyString(input.purpose, "purpose");
  if (typeof input.accountOwner !== "string" || !ACCOUNT_OWNERSHIP_VALUES.has(input.accountOwner)) {
    throw new InvalidConnectionAuthorityError(
      'accountOwner must be "CUSTOMER_OWNED" or "AKILTA_MANAGED" - no default is inferred',
    );
  }
  const minimumProviderScope = requireStringArray(
    input.minimumProviderScope,
    "minimumProviderScope",
  );
  const connectionMethod = requireNonEmptyString(input.connectionMethod, "connectionMethod");
  const validationRequirement = requireNonEmptyString(
    input.validationRequirement,
    "validationRequirement",
  );

  const base = {
    connectionRequirementId: connectionRequirementId as ConnectionRequirementId,
    ownership: input.ownership,
    requiredCapabilityRef: requiredCapabilityRef as RequirementId,
    purpose,
    accountOwner: input.accountOwner as AccountOwnership,
    minimumProviderScope,
    connectionMethod,
    validationRequirement,
  };

  if (input.requiredByRef === undefined) {
    return base;
  }
  const requiredByRef = requireNonEmptyString(input.requiredByRef, "requiredByRef");
  return { ...base, requiredByRef: requiredByRef as RequirementId };
}

/**
 * V2-CDO-004 "ConnectionBinding" (IN SCOPE #2). Tied to exactly one
 * `ConnectionRequirement` and one ownership tuple. `providerRef` /
 * `workspaceRef` / `integrationInstanceRef` are plain string references
 * only - no field here can hold a provider SDK object, OAuth token, or
 * invocation config (C11: provider neutrality is structural, not just
 * convention). `secretRef` is optional and, when present, is only the
 * opaque `SecretRef.secretRefId` - never raw credential material (C7).
 * Always constructed at `REQUESTED` (C6): binding construction alone can
 * never promote connection state to `VERIFIED`.
 */
export interface ConnectionBinding {
  readonly connectionBindingId: ConnectionBindingId;
  readonly connectionRequirementId: ConnectionRequirement["connectionRequirementId"];
  readonly ownership: ProjectOwnershipRef;
  readonly providerRef: string;
  readonly workspaceRef: string;
  readonly integrationInstanceRef: string;
  readonly delegatedScope: ReadonlyArray<string>;
  readonly connectionState: ConnectionState;
  readonly secretRef?: SecretRef["secretRefId"];
  readonly verificationEvidenceRef?: string;
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
 * C4: a binding cannot rebind its requirement to a different
 * customer/organization/project/service tuple - the given `ownership`
 * must exactly match `requirement.ownership`, checked before anything
 * else.
 *
 * C5 (this module's explicit reading of "repository-natural
 * subset/compatibility semantics", since the task head does not specify
 * an exact algorithm): `requirement.minimumProviderScope` is read as the
 * declared authorization ceiling for this requirement. `delegatedScope`
 * must be a non-empty subset of it whenever `minimumProviderScope` is
 * non-empty (an empty `minimumProviderScope` means the requirement
 * declares no provider-scope ceiling, so no delegated scope is required
 * either). Any `delegatedScope` entry absent from
 * `minimumProviderScope` is silent authority widening and rejects -
 * least-privilege delegation can narrow the declared ceiling but never
 * exceed it.
 */
export function createConnectionBinding(input: {
  connectionBindingId: unknown;
  requirement: ConnectionRequirement;
  ownership: ProjectOwnershipRef;
  providerRef: unknown;
  workspaceRef: unknown;
  integrationInstanceRef: unknown;
  delegatedScope: unknown;
  secretRef?: SecretRef;
}): ConnectionBinding {
  if (!ownershipEquals(input.ownership, input.requirement.ownership)) {
    throw new InvalidConnectionAuthorityError(
      "ownership does not match the given ConnectionRequirement's ownership tuple",
    );
  }
  const connectionBindingId = requireNonEmptyString(
    input.connectionBindingId,
    "connectionBindingId",
  );
  const providerRef = requireNonEmptyString(input.providerRef, "providerRef");
  const workspaceRef = requireNonEmptyString(input.workspaceRef, "workspaceRef");
  const integrationInstanceRef = requireNonEmptyString(
    input.integrationInstanceRef,
    "integrationInstanceRef",
  );
  const delegatedScope = requireStringArray(input.delegatedScope, "delegatedScope");

  if (input.requirement.minimumProviderScope.length > 0) {
    if (delegatedScope.length === 0) {
      throw new InvalidConnectionAuthorityError(
        "delegatedScope must not be empty when the requirement declares a minimumProviderScope",
      );
    }
    const allowed = new Set(input.requirement.minimumProviderScope);
    const widened = delegatedScope.filter((scope) => !allowed.has(scope));
    if (widened.length > 0) {
      throw new InvalidConnectionAuthorityError(
        `delegatedScope widens authority beyond the requirement's minimumProviderScope: ${widened.join(", ")}`,
      );
    }
  }

  const base = {
    connectionBindingId: connectionBindingId as ConnectionBindingId,
    connectionRequirementId: input.requirement.connectionRequirementId,
    ownership: input.ownership,
    providerRef,
    workspaceRef,
    integrationInstanceRef,
    delegatedScope,
    connectionState: "REQUESTED" as ConnectionState,
  };

  if (input.secretRef === undefined) {
    return base;
  }
  return { ...base, secretRef: input.secretRef.secretRefId };
}

const CONNECTION_MAIN_TRANSITIONS: ReadonlyMap<ConnectionState, ReadonlySet<ConnectionState>> = new Map([
  ["REQUESTED", new Set<ConnectionState>(["CONNECTED_UNVERIFIED", "REVOKED"])],
  ["CONNECTED_UNVERIFIED", new Set<ConnectionState>(["REVOKED"])],
  ["VERIFIED", new Set<ConnectionState>(["DEGRADED", "REVOKED", "HANDOVER_COMPLETE"])],
  ["DEGRADED", new Set<ConnectionState>(["REVOKED"])],
  ["REVOKED", new Set<ConnectionState>()],
  ["HANDOVER_COMPLETE", new Set<ConnectionState>()],
]);

/**
 * C10: `REVOKED` / `HANDOVER_COMPLETE` are state/reference semantics only
 * - reaching them here is a plain map lookup with no external effect
 * (no provider call, no AI Commerce write). Deliberately excludes any
 * `-> VERIFIED` edge (C6): the only way to reach `VERIFIED` is
 * `verifyConnectionBinding`, mirroring `outcome-job.ts`'s
 * `MAIN_PATH_TRANSITIONS` / `verifyOutcomeJob` split.
 */
export function transitionConnectionBinding(
  binding: ConnectionBinding,
  to: ConnectionState,
): ConnectionBinding {
  const allowed = CONNECTION_MAIN_TRANSITIONS.get(binding.connectionState);
  if (!allowed || !allowed.has(to)) {
    throw new InvalidConnectionTransitionError(binding.connectionState, to);
  }
  return { ...binding, connectionState: to };
}

/**
 * C6: the only function capable of setting `connectionState: "VERIFIED"`.
 * Requires the binding to currently be `CONNECTED_UNVERIFIED` or
 * `DEGRADED` (re-verification after degradation) and an explicit
 * non-empty `evidenceRef` - construction alone, or a bare state
 * assignment, can never promote verification (same evidence-gated
 * pattern as `ProjectCommunicationRecord`'s `DELIVERY_VERIFIED`
 * requiring a non-empty `evidenceRef`, `project-communication.ts` O5).
 */
export function verifyConnectionBinding(
  binding: ConnectionBinding,
  evidenceRef: unknown,
): ConnectionBinding {
  if (binding.connectionState !== "CONNECTED_UNVERIFIED" && binding.connectionState !== "DEGRADED") {
    throw new InvalidConnectionTransitionError(binding.connectionState, "VERIFIED");
  }
  const ref = requireNonEmptyString(evidenceRef, "evidenceRef");
  return { ...binding, connectionState: "VERIFIED", verificationEvidenceRef: ref };
}
