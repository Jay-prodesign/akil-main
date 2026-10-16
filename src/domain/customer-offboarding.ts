import type { TenantScope } from "./tenant-scope.js";
import type { Customer, LearningEligibility } from "./customer.js";
import type { EffectiveAccessResolution } from "./effective-organization-access.js";

/**
 * CUS-OFFBOARD-001 (AA-005 REV215 V2 floor slice continuation, Founder
 * "Continuous Completion Mode" direction): the canonical OS blueprint's V2
 * section names "full offboarding" and customer-facing "data export/delete"
 * semantics as required pre-GA capabilities. `OS-V1-04`'s
 * `organization-lifecycle-archive.ts` already closed this exact concern for
 * `Organization` (export/restore/offboard), but nothing in this repository
 * had ever closed the equivalent for a `Customer` - `customer.ts` carries no
 * lifecycle state at all today.
 *
 * Deliberately NOT mirrored by adding a mandatory field to `Customer`
 * itself: `createCustomer` is called from 75+ existing files across this
 * repository, every one of them already independently reviewed/accepted;
 * widening its required input shape would be a sweeping, high-blast-radius
 * change to a foundational type for a V2-floor concern, not the smallest
 * coherent reversible packet this corridor's own discipline calls for.
 * Instead, offboarding here is tracked exactly the way `organization-
 * onboarding.ts` tracks admission - as its own request/decision record that
 * POINTS AT an existing `Customer` by `(tenantId, customerId)`, never as a
 * mutation of `Customer` itself. `Customer` is consumed completely
 * unmodified, type-only.
 *
 * A request is always born `REQUESTED`; `completeCustomerOffboarding` fails
 * closed unless the given `customer` exactly matches the request's own
 * `(tenantId, customerId)` (no completing a different customer's request),
 * the caller's `currentAccess` is a fresh `GRANTED`
 * `EffectiveAccessResolution` bound to the SAME tenant with
 * `canPerformProtectedActions`, and the deciding principal (`currentAccess.
 * membershipId`) is distinct from the request's own `requestedByRef` (self-
 * completion is structurally impossible, mirroring `organization-
 * onboarding.ts`'s own self-admission guard and `partner-capability-
 * admission.ts`'s Rev55 F1 fix). On success it returns a scope-limited
 * export snapshot of the customer's own already-existing public fields -
 * mirroring `exportOrganizationLifecycleSnapshot`'s own "nothing to export
 * beyond the value's own public fields" discipline - plus the offboarding
 * decision's own provenance. `denyCustomerOffboardingRequest` is terminal,
 * no reconsideration path, mirroring `rejectOrganizationOnboardingRequest`.
 *
 * No real data deletion/purge across any other module is performed or
 * implied by this checkpoint - see "Explicitly deferred" in this
 * checkpoint's own exec-plan.
 *
 * REV216 F2 correction (Brain CHANGES_REQUIRED, PR #161 comment
 * `6205597388`): `denyCustomerOffboarding` originally took only a bare
 * `decidingAuthorityPrincipalRef` string and performed no authority/tenant
 * check of its own - an authenticated web boundary whose minimum floor is
 * READ (e.g. `requireInternalOsAccess`) could terminalize a request as
 * DENIED, since nothing downstream re-checked mutation permission. `denyCustomerOffboarding`
 * now takes `currentAccess: EffectiveAccessResolution`, exactly mirroring
 * `completeCustomerOffboarding`'s own existing discipline, so a non-web
 * caller cannot bypass this floor either: `currentAccess` must be a fresh
 * `GRANTED` resolution bound to the SAME tenant as the request, with a real
 * `membershipId`, and WRITE permission. Deliberately WRITE, not
 * `canPerformProtectedActions` - that stronger protected-action bar
 * remains reserved for `completeCustomerOffboarding` alone; denial is still
 * the weaker of the two decisions, just no longer weak enough to be
 * reachable by READ-only authority.
 */

export class InvalidCustomerOffboardingError extends Error {
  constructor(reason: string) {
    super(`Invalid CustomerOffboarding operation: ${reason}`);
    this.name = "InvalidCustomerOffboardingError";
  }
}

export class CustomerOffboardingDecisionError extends Error {
  constructor(reason: string) {
    super(`CustomerOffboarding decision rejected: ${reason}`);
    this.name = "CustomerOffboardingDecisionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidCustomerOffboardingError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidCustomerOffboardingError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidCustomerOffboardingError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const timestamp = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new InvalidCustomerOffboardingError(`${field} must be a valid ISO timestamp`);
  }
  return timestamp;
}

export type CustomerOffboardingRequestId = string & { readonly __brand: "CustomerOffboardingRequestId" };

export type CustomerOffboardingRequestStatus = "REQUESTED" | "COMPLETED" | "DENIED";

/**
 * Points at an existing `Customer` by `(tenantId, customerId)` only -
 * carries no copy of the customer's own mutable fields (displayName,
 * learningEligibility), so there is nothing here that could go stale
 * relative to the customer's own current record while the request is
 * pending.
 */
export interface CustomerOffboardingRequest {
  readonly requestId: CustomerOffboardingRequestId;
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly requestedByRef: string;
  readonly requestedAt: string;
  readonly status: CustomerOffboardingRequestStatus;
  readonly decidedByRef?: string;
  readonly decidedAt?: string;
  readonly denialReason?: string;
}

/** The only construction path for a request: always born `REQUESTED`, no caller-forgeable status. */
export function requestCustomerOffboarding(input: {
  requestId: unknown;
  customer: Customer;
  requestedByRef: unknown;
  requestedAt: unknown;
}): CustomerOffboardingRequest {
  const requestId = requireNonEmptyString(input.requestId, "requestId") as CustomerOffboardingRequestId;
  const requestedByRef = requireNonEmptyString(input.requestedByRef, "requestedByRef");
  const requestedAt = requireValidTimestamp(input.requestedAt, "requestedAt");
  return {
    requestId,
    tenantId: input.customer.tenantId,
    customerId: input.customer.customerId,
    requestedByRef,
    requestedAt,
    status: "REQUESTED",
  };
}

/**
 * Scope-limited, point-in-time projection of the customer's own already-
 * public fields ONLY - mirrors `OrganizationLifecycleSnapshot`'s own
 * discipline exactly. There is nothing here a restore/resurrection could
 * use, because this module defines no restore path at all: offboarding is
 * a one-way terminal decision, never reversed by this module.
 */
export interface CustomerOffboardingSnapshot {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly displayName: string;
  readonly learningEligibility: LearningEligibility;
  readonly offboardingRequestId: CustomerOffboardingRequestId;
  readonly completedAt: string;
  readonly completedByPrincipalRef: string;
}

export interface CustomerOffboardingCompletionResult {
  readonly completedRequest: CustomerOffboardingRequest;
  readonly snapshot: CustomerOffboardingSnapshot;
}

/**
 * Fails closed, in order, unless:
 * 1. `request.status === "REQUESTED"` - never completes an already-
 *    COMPLETED or already-DENIED request (no resurrection).
 * 2. `customer` exactly matches the request's own `(tenantId, customerId)` -
 *    a caller can never complete request A while exporting customer B's
 *    data.
 * 3. `currentAccess.decision === "GRANTED"` and
 *    `currentAccess.canPerformProtectedActions` - completing an offboarding
 *    (an export + terminal decision) is itself a protected action, gated
 *    exactly like `restoreOrganizationLifecycleFromSnapshot`.
 * 4. `currentAccess.tenantId === request.tenantId` - never crosses a tenant
 *    boundary.
 * 5. `currentAccess.membershipId` is defined AND distinct from
 *    `request.requestedByRef` - self-completion is structurally impossible.
 */
export function completeCustomerOffboarding(input: {
  request: CustomerOffboardingRequest;
  customer: Customer;
  currentAccess: EffectiveAccessResolution;
  completedAt: unknown;
}): CustomerOffboardingCompletionResult {
  const { request, customer, currentAccess } = input;
  if (request.status !== "REQUESTED") {
    throw new CustomerOffboardingDecisionError(
      `request "${request.requestId}" has status "${request.status}" - only a REQUESTED request may be completed, never resurrected from COMPLETED or DENIED`,
    );
  }
  if (customer.tenantId !== request.tenantId || customer.customerId !== request.customerId) {
    throw new CustomerOffboardingDecisionError(
      "customer does not match the exact (tenantId, customerId) this request was made for",
    );
  }
  if (currentAccess.decision !== "GRANTED") {
    throw new CustomerOffboardingDecisionError(
      "currentAccess must be a GRANTED EffectiveAccessResolution to complete a customer offboarding",
    );
  }
  if (!currentAccess.canPerformProtectedActions) {
    throw new CustomerOffboardingDecisionError(
      "completing a customer offboarding is a protected action - canPerformProtectedActions must be true",
    );
  }
  if (currentAccess.tenantId !== request.tenantId) {
    throw new CustomerOffboardingDecisionError(
      "currentAccess does not belong to the request's own tenant - completion never crosses a tenant boundary",
    );
  }
  if (currentAccess.membershipId === undefined) {
    throw new CustomerOffboardingDecisionError(
      "currentAccess must be bound to a real OrganizationMembership (a current authenticated principal) to complete an offboarding",
    );
  }
  if (currentAccess.membershipId === request.requestedByRef) {
    throw new CustomerOffboardingDecisionError(
      "the deciding principal must not equal the request's own requestedByRef - a requester can never complete their own offboarding",
    );
  }
  const completedAt = requireValidTimestamp(input.completedAt, "completedAt");

  const completedRequest: CustomerOffboardingRequest = {
    ...request,
    status: "COMPLETED",
    decidedByRef: currentAccess.membershipId,
    decidedAt: completedAt,
  };
  const snapshot: CustomerOffboardingSnapshot = {
    tenantId: customer.tenantId,
    customerId: customer.customerId,
    displayName: customer.displayName,
    learningEligibility: customer.learningEligibility,
    offboardingRequestId: request.requestId,
    completedAt,
    completedByPrincipalRef: currentAccess.membershipId,
  };
  return { completedRequest, snapshot };
}

/**
 * Terminal, one-way: a denied request is never reconsidered by this module
 * - submitting a fresh request is the only path forward. See this module's
 * own top-level doc comment (REV216 F2) for why `currentAccess` is required
 * here now, mirroring `completeCustomerOffboarding`'s own discipline.
 */
export function denyCustomerOffboarding(input: {
  request: CustomerOffboardingRequest;
  currentAccess: EffectiveAccessResolution;
  reason: unknown;
  deniedAt: unknown;
}): CustomerOffboardingRequest {
  const { request, currentAccess } = input;
  if (request.status !== "REQUESTED") {
    throw new CustomerOffboardingDecisionError(
      `request "${request.requestId}" has status "${request.status}" - only a REQUESTED request may be denied`,
    );
  }
  if (currentAccess.decision !== "GRANTED") {
    throw new CustomerOffboardingDecisionError(
      "currentAccess must be a GRANTED EffectiveAccessResolution to deny a customer offboarding",
    );
  }
  if (currentAccess.tenantId !== request.tenantId) {
    throw new CustomerOffboardingDecisionError(
      "currentAccess does not belong to the request's own tenant - denial never crosses a tenant boundary",
    );
  }
  if (currentAccess.membershipId === undefined) {
    throw new CustomerOffboardingDecisionError(
      "currentAccess must be bound to a real OrganizationMembership (a current authenticated principal) to deny an offboarding",
    );
  }
  if (!currentAccess.permissions.has("WRITE")) {
    throw new CustomerOffboardingDecisionError(
      "denying a customer offboarding requires WRITE permission - READ-only authority cannot terminalize a request",
    );
  }
  const reason = requireNonEmptyString(input.reason, "reason");
  const deniedAt = requireValidTimestamp(input.deniedAt, "deniedAt");
  return {
    ...request,
    status: "DENIED",
    decidedByRef: currentAccess.membershipId,
    decidedAt: deniedAt,
    denialReason: reason,
  };
}
