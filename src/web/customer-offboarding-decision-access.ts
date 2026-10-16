import { requireInternalOsAccess, type StaffAccessGrant } from "./internal-os-access.js";
import type { StaffSessionProvider } from "./staff-session-provider.js";
import type { Organization } from "../domain/organization.js";
import type { TenantScope } from "../domain/tenant-scope.js";
import {
  completeCustomerOffboarding,
  denyCustomerOffboarding,
  type CustomerOffboardingRequestId,
  type CustomerOffboardingSnapshot,
} from "../domain/customer-offboarding.js";
import type {
  DurableCustomerOffboardingRequestStore,
  StoredCustomerOffboardingRequest,
} from "../domain/durable-customer-offboarding-request-store.js";
import type { CustomerRepository } from "../ports/customer-repository.js";

/**
 * REV216 (AA-005, Founder Completion Directive): "the deferred authenticated
 * staff offboarding decision boundary" the Founder directive names by name.
 * `CUS-OFFBOARD-DURABLE-001`'s own "Fresh-scan result on the mutation-
 * boundary follow-up question" found this genuinely blocked on a missing
 * `Customer`-lookup capability - `completeCustomerOffboarding` requires a
 * real `Customer` object, and no durable implementation of the EXISTING
 * `CustomerRepository` port existed yet. REV216 corrects the premise (the
 * port and its production-shaped durable implementation now both exist)
 * and authorizes exactly this boundary.
 *
 * Mirrors `connector-connection-admin-access.ts`'s own exact rationale and
 * shape (Rev188 F2): `completeCustomerOffboarding`/`denyCustomerOffboarding`
 * each independently re-prove their own authority preconditions against a
 * caller-supplied `EffectiveAccessResolution`/`decidingAuthorityPrincipalRef`,
 * but neither authenticates that input itself - `resolveEffectiveOrganizationAccess`'s
 * own doc comment is explicit that it only proves a supplied membership
 * belongs to the identity the caller currently ASSERTS, assuming an
 * application boundary already authenticated that assertion. This module IS
 * that missing application boundary for customer-offboarding decisions: it
 * calls `requireInternalOsAccess` (OS-V0-08's staff ingress chain) FIRST,
 * and only then hands the domain functions the now-proven `context.access`/
 * `context.membership` for their own independent re-resolution immediately
 * before the mutation. A forged identity (no matching session) fails inside
 * `requireInternalOsAccess` itself, before either domain function or either
 * durable store is ever reached - zero store mutation either way.
 *
 * Deliberately two separate functions, not a combined "decision" union:
 * `completeCustomerOffboarding` and `denyCustomerOffboarding` are NOT
 * symmetric in this repository's own existing, unmodified domain contract -
 * only completion requires `currentAccess.canPerformProtectedActions`
 * (`completeCustomerOffboarding`'s own doc comment: "completing a customer
 * offboarding is a protected action"); denial requires only a currently-
 * ACTIVE staff membership (any `requireInternalOsAccess`-granted caller).
 * That asymmetry is this repository's own pre-existing, already-accepted
 * domain decision (`CUS-OFFBOARD-001`) - this module wires it through
 * faithfully, neither widening denial to require protected-action authority
 * nor narrowing completion's own existing protected-action requirement.
 *
 * REV216 F1 correction (Brain CHANGES_REQUIRED, PR #161 comment
 * `6205583270`): `requireInternalOsAccess` only proves authority for
 * `input.organization` - it says nothing about the SEPARATELY caller-
 * supplied `input.tenantScope` this module used for the actual store
 * lookup/mutation. `denyCustomerOffboarding`'s own domain contract performs
 * no tenant check at all (unlike `completeCustomerOffboarding`, which
 * happens to catch a tenant mismatch, but only after an already-completed
 * cross-tenant store read), so an authenticated Organization-A principal
 * could supply Tenant B's `tenantScope` and `requestId` and transition B's
 * request using A's authenticated identity. Both functions now require
 * `input.tenantScope.tenantId === context.access.tenantId` immediately
 * after `requireInternalOsAccess` returns and BEFORE any request-store
 * lookup - `context.access.tenantId` is `requireInternalOsAccess`'s own
 * proven-equal-to-`input.organization.tenantId` value (enforced inside
 * `resolveEffectiveOrganizationAccess` itself), so this is the one
 * authoritative tenant for the whole authenticated call; `tenantScope` is
 * never trusted as an independent dimension again once this check passes.
 */

export class CustomerOffboardingTenantScopeMismatchError extends Error {
  constructor(organizationTenantId: string, suppliedTenantId: string) {
    super(
      `supplied tenantScope "${suppliedTenantId}" does not match the authenticated organization's own tenant "${organizationTenantId}" - a customer offboarding decision never crosses a tenant boundary`,
    );
    this.name = "CustomerOffboardingTenantScopeMismatchError";
  }
}

export class CustomerOffboardingRequestNotFoundError extends Error {
  constructor(tenantId: string, requestId: string) {
    super(`CustomerOffboardingRequest "${requestId}" not found for tenant "${tenantId}"`);
    this.name = "CustomerOffboardingRequestNotFoundError";
  }
}

export class CustomerNotFoundForOffboardingDecisionError extends Error {
  constructor(tenantId: string, customerId: string) {
    super(`Customer "${customerId}" not found for tenant "${tenantId}" - cannot decide its offboarding request`);
    this.name = "CustomerNotFoundForOffboardingDecisionError";
  }
}

export interface CompletedCustomerOffboardingResult {
  readonly stored: StoredCustomerOffboardingRequest;
  readonly snapshot: CustomerOffboardingSnapshot;
}

/**
 * Looks up the exact `CustomerOffboardingRequest` and the exact `Customer`
 * it names, fresh, from the two real durable stores - never a caller-
 * supplied copy of either that could have drifted stale. `customer` is
 * looked up by the REQUEST's own `customerId` (never a caller-supplied
 * one), so a caller cannot substitute a different tenant's/customer's
 * record by passing a mismatched `Customer` directly - there is no such
 * parameter here to mismatch.
 */
export function completeCustomerOffboardingAsAuthenticatedStaff(input: {
  readonly organization: Organization;
  readonly provider: StaffSessionProvider;
  readonly sessionToken: string | undefined;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly requestStore: DurableCustomerOffboardingRequestStore;
  readonly customerRepository: CustomerRepository;
  readonly tenantScope: TenantScope;
  readonly requestId: CustomerOffboardingRequestId;
  readonly expectedVersion: number;
  readonly completedAt: unknown;
  /** OS-V1-02: optional, purely additive - see `requireStaffSession`'s own doc comment. */
  readonly now?: string;
}): CompletedCustomerOffboardingResult {
  const context = requireInternalOsAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    organization: input.organization,
    grants: input.grants,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (input.tenantScope.tenantId !== context.access.tenantId) {
    throw new CustomerOffboardingTenantScopeMismatchError(context.access.tenantId, input.tenantScope.tenantId);
  }
  const existing = input.requestStore.get(input.tenantScope.tenantId, input.requestId);
  if (existing === undefined) {
    throw new CustomerOffboardingRequestNotFoundError(input.tenantScope.tenantId, input.requestId);
  }
  const customer = input.customerRepository.findByTenantAndId(input.tenantScope, existing.request.customerId);
  if (customer === undefined) {
    throw new CustomerNotFoundForOffboardingDecisionError(input.tenantScope.tenantId, existing.request.customerId);
  }
  const { completedRequest, snapshot } = completeCustomerOffboarding({
    request: existing.request,
    customer,
    currentAccess: context.access,
    completedAt: input.completedAt,
  });
  const stored = input.requestStore.transitionToTerminal({
    tenantId: input.tenantScope.tenantId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    next: completedRequest,
  });
  return { stored, snapshot };
}

/**
 * `denyCustomerOffboarding` takes no `customer`/`currentAccess` at all (its
 * own existing contract) - only the authenticated `context.membership.membershipId`
 * is threaded through, as `decidingAuthorityPrincipalRef`.
 */
export function denyCustomerOffboardingAsAuthenticatedStaff(input: {
  readonly organization: Organization;
  readonly provider: StaffSessionProvider;
  readonly sessionToken: string | undefined;
  readonly grants: ReadonlyArray<StaffAccessGrant>;
  readonly requestStore: DurableCustomerOffboardingRequestStore;
  readonly tenantScope: TenantScope;
  readonly requestId: CustomerOffboardingRequestId;
  readonly expectedVersion: number;
  readonly reason: unknown;
  readonly deniedAt: unknown;
  /** OS-V1-02: optional, purely additive - see `requireStaffSession`'s own doc comment. */
  readonly now?: string;
}): StoredCustomerOffboardingRequest {
  const context = requireInternalOsAccess({
    provider: input.provider,
    sessionToken: input.sessionToken,
    organization: input.organization,
    grants: input.grants,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (input.tenantScope.tenantId !== context.access.tenantId) {
    throw new CustomerOffboardingTenantScopeMismatchError(context.access.tenantId, input.tenantScope.tenantId);
  }
  const existing = input.requestStore.get(input.tenantScope.tenantId, input.requestId);
  if (existing === undefined) {
    throw new CustomerOffboardingRequestNotFoundError(input.tenantScope.tenantId, input.requestId);
  }
  const deniedRequest = denyCustomerOffboarding({
    request: existing.request,
    decidingAuthorityPrincipalRef: context.membership.membershipId,
    reason: input.reason,
    deniedAt: input.deniedAt,
  });
  return input.requestStore.transitionToTerminal({
    tenantId: input.tenantScope.tenantId,
    requestId: input.requestId,
    expectedVersion: input.expectedVersion,
    next: deniedRequest,
  });
}
