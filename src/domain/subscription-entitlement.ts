import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";

/**
 * APP-SUB-001 (AA-005 Rev59): the smallest repository-native AKILTA
 * subscription/entitlement domain compatible with an embedded external
 * commerce launch. AKILTA owns `SubscriptionPlan`/`Subscription`/
 * `Entitlement` truth; the external commerce platform (checkout,
 * recurring charge execution, and card/payment-method storage) is a
 * separate, unnamed system this repository never couples to by name -
 * this repository's own project boundary keeps AKILTA free of any
 * hardcoded commerce-platform dependency, so every external reference
 * here is a deliberately generic, platform-agnostic pointer rather than
 * a named-platform type. Every external identifier that reaches this
 * module (storefront reference, external customer id, product/variant
 * id, selling-plan id, subscription contract id, order/payment/refund/
 * cancellation id) is treated as external provenance/evidence only -
 * never as AKILTA authority, and never sufficient by itself to activate
 * or widen anything. This module has no import from `authority.ts` or
 * `organization-membership.ts` at all (see
 * `tests/app-sub-001-boundary-scan.test.ts`) - an external platform's
 * own shop/customer/staff roles and permissions cannot reach, create,
 * widen, or mutate AKILTA `OrganizationRole`/membership/READ/WRITE/
 * EXECUTE/protected-action authority through this module, structurally,
 * not by convention.
 *
 * `SubscriptionPlan` is deliberately distinct from `ProjectPlanVersion`
 * (`project-plan.ts`): the former is AKILTA's own commercial-plan catalog
 * truth (what a customer is subscribed to), the latter is delivery-work
 * planning truth for one project - reusing either for the other's concern
 * would conflate two genuinely different domains this repository already
 * keeps separate.
 *
 * Real gateway charging, recurring card storage, and raw card handling
 * remain entirely outside AKILTA - no field anywhere in this module can
 * hold a card number, payment-method token, or gateway credential; every
 * commerce reference is an opaque string pointer, mirroring
 * `connection-authority.ts`'s own `SecretRef` "opaque reference, never
 * real secret material" discipline. Live webhook signature verification,
 * app credentials, and network transport are later, separately protected
 * integration effects - not fabricated here. No direct payment-gateway
 * credential or adapter exists anywhere in this module (see the
 * boundary-scan test's "gateway/provider independence" proof).
 */

export class InvalidSubscriptionEntitlementError extends Error {
  constructor(reason: string) {
    super(`Invalid subscription/entitlement operation: ${reason}`);
    this.name = "InvalidSubscriptionEntitlementError";
  }
}

export class AmbiguousExternalCustomerLinkageError extends Error {
  constructor(storefrontRef: string, externalCustomerRef: string) {
    super(
      `External customer "${externalCustomerRef}" in storefront "${storefrontRef}" is already linked to a different AKILTA tenant/customer - an ambiguous external identity is never silently repointed`,
    );
    this.name = "AmbiguousExternalCustomerLinkageError";
  }
}

export class ExternalSubscriptionPlanMappingAlreadyAdmittedError extends Error {
  constructor(storefrontRef: string, externalProductOrVariantRef: string, externalSellingPlanRef: string) {
    super(
      `External product/variant "${externalProductOrVariantRef}" + selling plan "${externalSellingPlanRef}" in storefront "${storefrontRef}" is already admitted to a different SubscriptionPlan - re-admitting a different mapping is never silently accepted`,
    );
    this.name = "ExternalSubscriptionPlanMappingAlreadyAdmittedError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidSubscriptionEntitlementError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidSubscriptionEntitlementError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidSubscriptionEntitlementError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// SubscriptionPlan: AKILTA's own commercial-plan catalog truth.
// ---------------------------------------------------------------------------

export type SubscriptionPlanId = string & { readonly __brand: "SubscriptionPlanId" };

export interface SubscriptionPlan {
  readonly tenantId: TenantScope["tenantId"];
  readonly subscriptionPlanId: SubscriptionPlanId;
  readonly displayName: string;
  readonly grantedEntitlementRefs: ReadonlyArray<string>;
}

export function createSubscriptionPlan(input: {
  tenantScope: TenantScope;
  subscriptionPlanId: unknown;
  displayName: unknown;
  grantedEntitlementRefs: ReadonlyArray<unknown>;
}): SubscriptionPlan {
  const subscriptionPlanId = requireNonEmptyString(input.subscriptionPlanId, "subscriptionPlanId") as SubscriptionPlanId;
  const displayName = requireNonEmptyString(input.displayName, "displayName");
  if (!Array.isArray(input.grantedEntitlementRefs)) {
    throw new InvalidSubscriptionEntitlementError("grantedEntitlementRefs must be an array");
  }
  const grantedEntitlementRefs = input.grantedEntitlementRefs.map((ref, index) =>
    requireNonEmptyString(ref, `grantedEntitlementRefs[${index}]`),
  );
  return {
    tenantId: input.tenantScope.tenantId,
    subscriptionPlanId,
    displayName,
    grantedEntitlementRefs,
  };
}

// ---------------------------------------------------------------------------
// External customer identity -> AKILTA tenant/customer linkage.
// Collision-safe keying (JSON.stringify of the identity tuple) mirrors this
// corridor's own established injective-encoding discipline (CXP-001K/L/R/
// U/V/W): storefrontRef and externalCustomerRef are validated only as
// non-empty strings, never as delimiter-free, so raw concatenation would
// not be a collision-safe key.
// ---------------------------------------------------------------------------

export interface ExternalCustomerLinkage {
  readonly storefrontRef: string;
  readonly externalCustomerRef: string;
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly linkedAt: string;
}

function externalCustomerKey(storefrontRef: string, externalCustomerRef: string): string {
  return JSON.stringify([storefrontRef, externalCustomerRef]);
}

export interface ExternalCustomerLinkageRegistry {
  /**
   * The only construction path for an `ExternalCustomerLinkage`. Re-linking
   * the identical `(storefrontRef, externalCustomerRef)` pair to the
   * identical tenant/customer is a safe no-op (idempotent under retry/
   * replay); re-linking it to a *different* tenant/customer fails closed
   * with `AmbiguousExternalCustomerLinkageError` rather than silently
   * repointing an existing customer's commerce identity.
   */
  linkOnce(input: {
    storefrontRef: unknown;
    externalCustomerRef: unknown;
    tenantScope: TenantScope;
    customer: Customer;
    linkedAt: unknown;
  }): ExternalCustomerLinkage;
  /** Fail-closed by construction: an unmapped identity resolves to `undefined`, never a guess. */
  resolve(storefrontRef: string, externalCustomerRef: string): ExternalCustomerLinkage | undefined;
}

export function createExternalCustomerLinkageRegistry(): ExternalCustomerLinkageRegistry {
  const linked = new Map<string, ExternalCustomerLinkage>();
  return {
    linkOnce(input) {
      const storefrontRef = requireNonEmptyString(input.storefrontRef, "storefrontRef");
      const externalCustomerRef = requireNonEmptyString(input.externalCustomerRef, "externalCustomerRef");
      const linkedAt = requireNonEmptyString(input.linkedAt, "linkedAt");
      if (input.customer.tenantId !== input.tenantScope.tenantId) {
        throw new InvalidSubscriptionEntitlementError("customer must belong to the given tenantScope");
      }
      const key = externalCustomerKey(storefrontRef, externalCustomerRef);
      const existing = linked.get(key);
      if (existing !== undefined) {
        if (existing.tenantId !== input.tenantScope.tenantId || existing.customerId !== input.customer.customerId) {
          throw new AmbiguousExternalCustomerLinkageError(storefrontRef, externalCustomerRef);
        }
        return existing;
      }
      const linkage: ExternalCustomerLinkage = {
        storefrontRef,
        externalCustomerRef,
        tenantId: input.tenantScope.tenantId,
        customerId: input.customer.customerId,
        linkedAt,
      };
      linked.set(key, linkage);
      return linkage;
    },
    resolve(storefrontRef, externalCustomerRef) {
      return linked.get(externalCustomerKey(storefrontRef, externalCustomerRef));
    },
  };
}

// ---------------------------------------------------------------------------
// External product/variant + selling-plan -> AKILTA SubscriptionPlan
// mapping. Mirrors `service-catalog-admission.ts`'s own single-gate,
// immutable-once-admitted discipline - a caller-fabricated mapping (a free
// "this external product means this SubscriptionPlan" assertion with no
// admission gate) is exactly the un-trusted-catalog-lookup gap that
// module's own doc comments already named as unacceptable for a different
// domain; this is the smallest task-local admission boundary for this one.
// ---------------------------------------------------------------------------

export interface ExternalSubscriptionPlanMapping {
  readonly storefrontRef: string;
  readonly externalProductOrVariantRef: string;
  readonly externalSellingPlanRef: string;
  readonly tenantId: TenantScope["tenantId"];
  readonly subscriptionPlanId: SubscriptionPlanId;
  readonly admittedByAuthorityId: string;
  readonly evidenceRef: string;
  readonly admittedAt: string;
}

function externalPlanMappingKey(storefrontRef: string, externalProductOrVariantRef: string, externalSellingPlanRef: string): string {
  return JSON.stringify([storefrontRef, externalProductOrVariantRef, externalSellingPlanRef]);
}

export interface ExternalSubscriptionPlanMappingRegistry {
  /**
   * The only construction path for an `ExternalSubscriptionPlanMapping`.
   * Re-admitting the identical mapping to the identical `SubscriptionPlan`
   * is a safe no-op; admitting a *different* `SubscriptionPlan` for an
   * already-admitted external product/selling-plan pair fails closed.
   */
  admit(input: {
    storefrontRef: unknown;
    externalProductOrVariantRef: unknown;
    externalSellingPlanRef: unknown;
    plan: SubscriptionPlan;
    admittedByAuthorityId: unknown;
    evidenceRef: unknown;
    admittedAt: unknown;
  }): ExternalSubscriptionPlanMapping;
  resolve(
    storefrontRef: string,
    externalProductOrVariantRef: string,
    externalSellingPlanRef: string,
  ): ExternalSubscriptionPlanMapping | undefined;
}

export function createExternalSubscriptionPlanMappingRegistry(): ExternalSubscriptionPlanMappingRegistry {
  const admitted = new Map<string, ExternalSubscriptionPlanMapping>();
  return {
    admit(input) {
      const storefrontRef = requireNonEmptyString(input.storefrontRef, "storefrontRef");
      const externalProductOrVariantRef = requireNonEmptyString(input.externalProductOrVariantRef, "externalProductOrVariantRef");
      const externalSellingPlanRef = requireNonEmptyString(input.externalSellingPlanRef, "externalSellingPlanRef");
      const admittedByAuthorityId = requireNonEmptyString(input.admittedByAuthorityId, "admittedByAuthorityId");
      const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
      const admittedAt = requireNonEmptyString(input.admittedAt, "admittedAt");
      const key = externalPlanMappingKey(storefrontRef, externalProductOrVariantRef, externalSellingPlanRef);
      const existing = admitted.get(key);
      if (existing !== undefined) {
        if (existing.subscriptionPlanId !== input.plan.subscriptionPlanId || existing.tenantId !== input.plan.tenantId) {
          throw new ExternalSubscriptionPlanMappingAlreadyAdmittedError(storefrontRef, externalProductOrVariantRef, externalSellingPlanRef);
        }
        return existing;
      }
      const mapping: ExternalSubscriptionPlanMapping = {
        storefrontRef,
        externalProductOrVariantRef,
        externalSellingPlanRef,
        tenantId: input.plan.tenantId,
        subscriptionPlanId: input.plan.subscriptionPlanId,
        admittedByAuthorityId,
        evidenceRef,
        admittedAt,
      };
      admitted.set(key, mapping);
      return mapping;
    },
    resolve(storefrontRef, externalProductOrVariantRef, externalSellingPlanRef) {
      return admitted.get(externalPlanMappingKey(storefrontRef, externalProductOrVariantRef, externalSellingPlanRef));
    },
  };
}

// ---------------------------------------------------------------------------
// Subscription lifecycle. `PAST_DUE` is this module's grace window: Rev59
// names "pause/past-due/grace/cancel/expiry" as the lifecycle dimensions
// that must all fail closed, not as a mandate for a fourth, textually-
// distinct GRACE state - PAST_DUE already *is* that window here, disclosed
// honestly rather than fabricating a state with no distinct behavior of its
// own. Entitlement is revoked immediately on entering PAST_DUE (the fail-
// closed default: an unresolved payment problem never continues to imply
// paid access) and restored only by a verified PAYMENT_RECOVERED fact.
// ---------------------------------------------------------------------------

export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };

export type SubscriptionStatus = "PENDING_ACTIVATION" | "ACTIVE" | "PAST_DUE" | "PAUSED" | "CANCELED" | "EXPIRED";

export type SubscriptionLifecycleFactType =
  | "ACTIVATION_VERIFIED"
  | "RENEWAL_VERIFIED"
  | "PAYMENT_FAILED"
  | "PAYMENT_RECOVERED"
  | "PAUSED"
  | "RESUMED"
  | "CANCELED"
  | "EXPIRED";

/**
 * `factId` is the idempotency key (E7-style, mirroring `engineering-run-
 * state.ts`'s own fencing/dedup discipline): applying the identical
 * `factId` twice - even after later facts have moved the subscription
 * further - is always a safe no-op, never a regression. `externalFactRef`
 * is an opaque external-platform evidence pointer (order/payment/refund/
 * cancellation id) - never interpreted, never a credential.
 *
 * Checkout intent, a draft order, an unpaid order, or any unverifiable
 * provider state must never be represented as an `ACTIVATION_VERIFIED` (or
 * any other) fact - this module has no field or fact type for an
 * unverified claim at all, so the honest way to represent one is to never
 * construct a fact for it, not to construct one and mark it "pending."
 */
export interface SubscriptionLifecycleFact {
  readonly factId: string;
  readonly factType: SubscriptionLifecycleFactType;
  readonly occurredAt: string;
  readonly externalFactRef: string;
  readonly newPeriodEnd?: string;
}

export interface Subscription {
  readonly subscriptionId: SubscriptionId;
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly subscriptionPlanId: SubscriptionPlanId;
  readonly storefrontRef: string;
  readonly externalSubscriptionContractRef: string;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: string | undefined;
  readonly appliedFactIds: ReadonlyArray<string>;
}

/**
 * The only construction path for a `Subscription`: tenant/customer/plan
 * identity is always derived from an already-resolved, trusted
 * `ExternalCustomerLinkage` + `ExternalSubscriptionPlanMapping` - never
 * accepted as free caller-supplied strings. A subscription is always born
 * `PENDING_ACTIVATION`; only a later verified `ACTIVATION_VERIFIED` fact
 * can move it to `ACTIVE`.
 */
export function createPendingSubscription(input: {
  subscriptionId: unknown;
  customerLinkage: ExternalCustomerLinkage;
  planMapping: ExternalSubscriptionPlanMapping;
  externalSubscriptionContractRef: unknown;
}): Subscription {
  if (input.customerLinkage.storefrontRef !== input.planMapping.storefrontRef) {
    throw new InvalidSubscriptionEntitlementError("customerLinkage and planMapping must belong to the same storefront");
  }
  if (input.customerLinkage.tenantId !== input.planMapping.tenantId) {
    throw new InvalidSubscriptionEntitlementError("customerLinkage and planMapping must belong to the same AKILTA tenant");
  }
  const subscriptionId = requireNonEmptyString(input.subscriptionId, "subscriptionId") as SubscriptionId;
  const externalSubscriptionContractRef = requireNonEmptyString(
    input.externalSubscriptionContractRef,
    "externalSubscriptionContractRef",
  );
  return {
    subscriptionId,
    tenantId: input.customerLinkage.tenantId,
    customerId: input.customerLinkage.customerId,
    subscriptionPlanId: input.planMapping.subscriptionPlanId,
    storefrontRef: input.customerLinkage.storefrontRef,
    externalSubscriptionContractRef,
    status: "PENDING_ACTIVATION",
    currentPeriodEnd: undefined,
    appliedFactIds: [],
  };
}

function resolveNextStatus(from: SubscriptionStatus, factType: SubscriptionLifecycleFactType): SubscriptionStatus | undefined {
  switch (factType) {
    case "ACTIVATION_VERIFIED":
      return from === "PENDING_ACTIVATION" ? "ACTIVE" : undefined;
    case "RENEWAL_VERIFIED":
      return from === "ACTIVE" ? "ACTIVE" : undefined;
    case "PAYMENT_FAILED":
      return from === "ACTIVE" ? "PAST_DUE" : undefined;
    case "PAYMENT_RECOVERED":
      return from === "PAST_DUE" ? "ACTIVE" : undefined;
    case "PAUSED":
      return from === "ACTIVE" ? "PAUSED" : undefined;
    case "RESUMED":
      return from === "PAUSED" ? "ACTIVE" : undefined;
    case "CANCELED":
      return from === "ACTIVE" || from === "PAST_DUE" || from === "PAUSED" ? "CANCELED" : undefined;
    case "EXPIRED":
      return from === "PAST_DUE" ? "EXPIRED" : undefined;
  }
}

/**
 * Pure reducer, never throws on a structurally well-formed fact: a
 * duplicate `factId` (replay) or a fact that names no legal transition
 * from the subscription's current status (stale/out-of-order delivery) is
 * always a safe no-op that still records `factId` as seen - so a later
 * replay of that same stale fact remains a no-op too, and the
 * subscription's own status/period are never regressed by a fact a later
 * one has already superseded.
 */
export function applySubscriptionLifecycleFact(subscription: Subscription, fact: SubscriptionLifecycleFact): Subscription {
  if (subscription.appliedFactIds.includes(fact.factId)) {
    return subscription;
  }
  const nextStatus = resolveNextStatus(subscription.status, fact.factType);
  if (nextStatus === undefined) {
    return { ...subscription, appliedFactIds: [...subscription.appliedFactIds, fact.factId] };
  }
  return {
    ...subscription,
    status: nextStatus,
    currentPeriodEnd: fact.newPeriodEnd ?? subscription.currentPeriodEnd,
    appliedFactIds: [...subscription.appliedFactIds, fact.factId],
  };
}

/** Replays a full fact log against a freshly created pending subscription - restart/reconstruction is provably identical to incremental application. */
export function reconstructSubscription(
  initial: ReturnType<typeof createPendingSubscription>,
  facts: ReadonlyArray<SubscriptionLifecycleFact>,
): Subscription {
  return facts.reduce(applySubscriptionLifecycleFact, initial);
}

// ---------------------------------------------------------------------------
// Entitlement: a pure derivation, never separately stored/mutable state.
// Never equates entitlement with invoice/payment-record state - it depends
// only on the subscription's own already-fail-closed status.
// ---------------------------------------------------------------------------

export interface Entitlement {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly entitlementRefs: ReadonlyArray<string>;
  readonly isActive: boolean;
}

const ENTITLED_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(["ACTIVE"]);

export function deriveEntitlement(subscription: Subscription, plan: SubscriptionPlan): Entitlement {
  if (subscription.tenantId !== plan.tenantId || subscription.subscriptionPlanId !== plan.subscriptionPlanId) {
    throw new InvalidSubscriptionEntitlementError(
      "plan must be the exact SubscriptionPlan this subscription is bound to - a mismatched or foreign-tenant plan can never derive this subscription's entitlement",
    );
  }
  const isActive = ENTITLED_STATUSES.has(subscription.status);
  return {
    tenantId: subscription.tenantId,
    customerId: subscription.customerId,
    entitlementRefs: isActive ? plan.grantedEntitlementRefs : [],
    isActive,
  };
}
