import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { AdmittedWorker } from "./worker-routing-policy.js";

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
   *
   * Rev60 F1 correction: this previously accepted a bare, caller-supplied
   * `admittedByAuthorityId` string with no admission/authority binding at
   * all - a free label, never an actual admitted-authority decision, so an
   * external platform's own untrusted role could "admit" a plan mapping
   * just by asserting a plausible-looking id. Mirrors
   * `service-catalog-admission.ts`'s own Rev102 F2 fix exactly: reuses
   * `worker-routing-policy.ts`'s existing, already-established, non-
   * tenant-scoped admitted-identity/authority-level primitive
   * (`AdmittedWorker`) rather than inventing a second IAM model. An
   * `authorizingWorker` that is not `trustStatus: "ADMITTED"` or not
   * `authorityLevel: "ELEVATED"` can never admit a mapping - an unproven/
   * untrusted/standard-authority caller label can no longer silently
   * become trusted subscription-plan-mapping authority.
   */
  admit(input: {
    storefrontRef: unknown;
    externalProductOrVariantRef: unknown;
    externalSellingPlanRef: unknown;
    plan: SubscriptionPlan;
    authorizingWorker: AdmittedWorker;
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
      if (input.authorizingWorker.trustStatus !== "ADMITTED") {
        throw new InvalidSubscriptionEntitlementError(
          `authorizingWorker must have trustStatus "ADMITTED" (got "${input.authorizingWorker.trustStatus}") - an unproven/untrusted caller cannot admit a subscription-plan mapping`,
        );
      }
      if (input.authorizingWorker.authorityLevel !== "ELEVATED") {
        throw new InvalidSubscriptionEntitlementError(
          `authorizingWorker must have authorityLevel "ELEVATED" (got "${input.authorizingWorker.authorityLevel}") - only elevated-authority workers may admit a trusted subscription-plan mapping`,
        );
      }
      const admittedByAuthorityId = input.authorizingWorker.workerId;
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
 *
 * Rev60 F2 correction: this previously carried no subscription-identifying
 * provenance at all - nothing bound a fact to the one `Subscription` it
 * actually pertains to, so a fact genuinely about one subscription could be
 * (by caller bug or cross-subscription contamination) applied to a wholly
 * different one and would be accepted unconditionally. `storefrontRef` and
 * `externalSubscriptionContractRef` are that binding: they must match the
 * target `Subscription`'s own fields exactly, checked both at construction
 * (see `createVerifiedSubscriptionLifecycleFact`) and again at application
 * (see `applySubscriptionLifecycleFact`) as defense in depth.
 */
export interface SubscriptionLifecycleFact {
  readonly factId: string;
  readonly factType: SubscriptionLifecycleFactType;
  readonly occurredAt: string;
  readonly storefrontRef: string;
  readonly externalSubscriptionContractRef: string;
  readonly externalFactRef: string;
  readonly newPeriodEnd?: string;
}

/**
 * Rev60 F2 correction: the only construction path for a
 * `SubscriptionLifecycleFact`. The caller must already have resolved which
 * `Subscription` a verified external event pertains to (e.g. by looking up
 * `externalSubscriptionContractRef` in a subscription store) and supplies
 * that exact `Subscription` here; the given `storefrontRef` and
 * `externalSubscriptionContractRef` must match it exactly, or construction
 * fails closed immediately. This is deliberately the smallest possible
 * provenance boundary - it reuses the already-resolved `Subscription`
 * (itself only ever derived from a trusted `ExternalCustomerLinkage` +
 * `ExternalSubscriptionPlanMapping`) as the AKILTA subscription/customer/
 * tenant coherence anchor, rather than inventing a second identity model.
 */
export function createVerifiedSubscriptionLifecycleFact(input: {
  subscription: Subscription;
  storefrontRef: unknown;
  externalSubscriptionContractRef: unknown;
  factId: unknown;
  factType: SubscriptionLifecycleFactType;
  occurredAt: unknown;
  externalFactRef: unknown;
  newPeriodEnd?: unknown;
}): SubscriptionLifecycleFact {
  const storefrontRef = requireNonEmptyString(input.storefrontRef, "storefrontRef");
  const externalSubscriptionContractRef = requireNonEmptyString(
    input.externalSubscriptionContractRef,
    "externalSubscriptionContractRef",
  );
  if (
    storefrontRef !== input.subscription.storefrontRef ||
    externalSubscriptionContractRef !== input.subscription.externalSubscriptionContractRef
  ) {
    throw new InvalidSubscriptionEntitlementError(
      `lifecycle fact provenance (storefront "${storefrontRef}", contract "${externalSubscriptionContractRef}") does not match the target subscription's own storefront "${input.subscription.storefrontRef}" / contract "${input.subscription.externalSubscriptionContractRef}" - a fact can never be constructed for a subscription it does not actually belong to`,
    );
  }
  const factId = requireNonEmptyString(input.factId, "factId");
  const occurredAt = requireNonEmptyString(input.occurredAt, "occurredAt");
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new InvalidSubscriptionEntitlementError("occurredAt must be a valid ISO timestamp");
  }
  const externalFactRef = requireNonEmptyString(input.externalFactRef, "externalFactRef");
  return {
    factId,
    factType: input.factType,
    occurredAt,
    storefrontRef,
    externalSubscriptionContractRef,
    externalFactRef,
    ...(input.newPeriodEnd === undefined ? {} : { newPeriodEnd: requireNonEmptyString(input.newPeriodEnd, "newPeriodEnd") }),
  };
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
  readonly appliedFacts: ReadonlyArray<SubscriptionLifecycleFact>;
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
    appliedFacts: [],
  };
}

/**
 * Rev60 F3 correction: `CANCELED` is now also a legal transition from
 * `PENDING_ACTIVATION` (a subscription can genuinely be verified-canceled
 * before it was ever activated). This is load-bearing together with the
 * temporal re-fold in `applySubscriptionLifecycleFact`: without it, a
 * verified cancellation that truly occurred before activation - but is
 * delivered to this reducer after the activation fact - would have no
 * legal transition to record itself against even once correctly re-
 * ordered by `occurredAt`, and would be silently discarded exactly as
 * Rev60 F3 found.
 */
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
      return from === "PENDING_ACTIVATION" || from === "ACTIVE" || from === "PAST_DUE" || from === "PAUSED"
        ? "CANCELED"
        : undefined;
    case "EXPIRED":
      return from === "PAST_DUE" ? "EXPIRED" : undefined;
  }
}

function factSequenceKey(fact: SubscriptionLifecycleFact): [number, string] {
  return [Date.parse(fact.occurredAt), fact.factId];
}

/**
 * Rev60 F3 correction: folds a full fact set in true `occurredAt` order
 * (factId as a deterministic tiebreaker) from a subscription's birth
 * state, rather than trusting delivery order. A fact that names no legal
 * transition at its position in the *true* sequence contributes nothing to
 * status/period but is still retained in the log, so a subsequently-
 * arriving fact that is chronologically earlier can be correctly re-
 * inserted into its true position and re-folded - this is what makes
 * out-of-order delivery (e.g. a `PAYMENT_RECOVERED` webhook arriving before
 * the `PAYMENT_FAILED` one it responds to, or a verified cancellation
 * arriving after a later-delivered-but-earlier-occurring activation)
 * resolve to the same final state regardless of arrival order.
 */
function foldFactsInTemporalOrder(
  base: Subscription,
  facts: ReadonlyArray<SubscriptionLifecycleFact>,
): Subscription {
  const sorted = [...facts].sort((a, b) => {
    const [ta, ida] = factSequenceKey(a);
    const [tb, idb] = factSequenceKey(b);
    if (ta !== tb) return ta - tb;
    return ida < idb ? -1 : ida > idb ? 1 : 0;
  });
  let status: SubscriptionStatus = "PENDING_ACTIVATION";
  let currentPeriodEnd: string | undefined = undefined;
  for (const candidate of sorted) {
    const nextStatus = resolveNextStatus(status, candidate.factType);
    if (nextStatus !== undefined) {
      status = nextStatus;
      currentPeriodEnd = candidate.newPeriodEnd ?? currentPeriodEnd;
    }
  }
  return { ...base, status, currentPeriodEnd, appliedFacts: sorted };
}

/**
 * Pure reducer, fail-closed on cross-subscription contamination (Rev60 F2)
 * and malformed timestamps, and replay/order-safe by full temporal re-fold
 * (Rev60 F3): a duplicate `factId` is always a safe no-op, and any other
 * fact - however it arrives relative to the others already on file - is
 * inserted into the subscription's own fact log and the *entire* log is
 * re-folded in true `occurredAt` order, so out-of-order delivery can never
 * produce a status/entitlement inconsistent with the true verified fact
 * sequence, and a terminal negative fact (e.g. a verified cancellation)
 * can never be escaped by a chronologically-earlier fact arriving later.
 */
export function applySubscriptionLifecycleFact(subscription: Subscription, fact: SubscriptionLifecycleFact): Subscription {
  if (
    fact.storefrontRef !== subscription.storefrontRef ||
    fact.externalSubscriptionContractRef !== subscription.externalSubscriptionContractRef
  ) {
    throw new InvalidSubscriptionEntitlementError(
      `lifecycle fact "${fact.factId}" (storefront "${fact.storefrontRef}", contract "${fact.externalSubscriptionContractRef}") does not match this subscription's own storefront "${subscription.storefrontRef}" / contract "${subscription.externalSubscriptionContractRef}" - a cross-subscription lifecycle fact is never applied`,
    );
  }
  if (Number.isNaN(Date.parse(fact.occurredAt))) {
    throw new InvalidSubscriptionEntitlementError(`lifecycle fact "${fact.factId}" has an invalid occurredAt timestamp`);
  }
  if (subscription.appliedFacts.some((applied) => applied.factId === fact.factId)) {
    return subscription;
  }
  return foldFactsInTemporalOrder(subscription, [...subscription.appliedFacts, fact]);
}

/** Replays a full fact log against a freshly created pending subscription - restart/reconstruction is provably identical to incremental application, and to any other delivery order of the same fact set (Rev60 F3). */
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
