import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Subscription, Entitlement } from "./subscription-entitlement.js";
import type { QuotaAdmissionScope, QuotaReadModel } from "./execution-quota-admission.js";

/**
 * APP-SUB-002 (AA-005 REV215 V2 floor slice continuation): the canonical OS
 * blueprint's V2 section lists "customer-facing usage/quota/credit and
 * upgrade/downgrade/suspend/cancel flows" as a required pre-GA capability.
 * `APP-SUB-001` (`subscription-entitlement.ts`) already provides the
 * subscription/entitlement lifecycle side (including upgrade/downgrade via
 * `changeSubscriptionPlan` and suspend/cancel via verified
 * `SubscriptionLifecycleFact`s); `OS-V0-07` (`execution-quota-admission.ts`,
 * already on `main`) already provides a truthful, fail-closed usage/credit
 * read model (`QuotaReadModel`). Neither module has previously been
 * composed into the single customer-safe status view a customer-facing
 * surface would actually need to render ("what am I subscribed to, is it
 * active, what have I used"). This module is exactly that composition -
 * a pure read-model projection, zero new persistence, zero new dependency -
 * mirroring this repository's own established pattern for this class of
 * work (`CXP-ACT-001`'s `buildClientProjectSnapshot` composing
 * `ProjectActivationProfile` into the customer-safe snapshot).
 *
 * Every field here is read-through from an already-fail-closed source;
 * nothing is fabricated, recomputed speculatively, or defaulted when a
 * source value is absent. The only new invariant this module itself
 * enforces is the fail-closed tenant/customer binding below - without it, a
 * caller could (by bug or malice) compose one customer's subscription with
 * a DIFFERENT customer's quota/usage data into a single status view, which
 * would be a cross-customer data leak structurally indistinguishable from
 * the leaks this repository's other composition boundaries already guard
 * against (see `project-activation-profile.ts`'s own ownership-equality
 * check for the established precedent this mirrors).
 */
export class InvalidSubscriptionUsageStatusError extends Error {
  constructor(reason: string) {
    super(`Invalid subscription usage status composition: ${reason}`);
    this.name = "InvalidSubscriptionUsageStatusError";
  }
}

export interface SubscriptionUsageStatus {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly subscriptionStatus: Subscription["status"];
  readonly isEntitled: boolean;
  readonly entitlementRefs: ReadonlyArray<string>;
  readonly usage: QuotaReadModel;
}

/**
 * Composes an already-derived `Entitlement` and an already-projected
 * `QuotaReadModel` into one customer-safe status view for the given
 * `subscription`. Fails closed (throws, never silently substitutes or
 * drops data) unless `entitlement` and `quotaScope` both belong to the
 * exact same tenant/customer as `subscription` - the same cross-scope
 * ownership check every other composition boundary in this repository
 * already enforces.
 */
export function projectSubscriptionUsageStatus(input: {
  subscription: Subscription;
  entitlement: Entitlement;
  quotaScope: QuotaAdmissionScope;
  quotaReadModel: QuotaReadModel;
}): SubscriptionUsageStatus {
  if (
    input.entitlement.tenantId !== input.subscription.tenantId ||
    input.entitlement.customerId !== input.subscription.customerId
  ) {
    throw new InvalidSubscriptionUsageStatusError(
      "entitlement must belong to the exact same tenant/customer as the subscription - a foreign or mismatched entitlement can never compose into this subscription's usage status",
    );
  }
  if (
    input.quotaScope.tenantId !== input.subscription.tenantId ||
    input.quotaScope.customerId !== input.subscription.customerId
  ) {
    throw new InvalidSubscriptionUsageStatusError(
      "quotaScope must belong to the exact same tenant/customer as the subscription - a foreign or mismatched quota scope can never compose into this subscription's usage status",
    );
  }

  return {
    tenantId: input.subscription.tenantId,
    customerId: input.subscription.customerId,
    subscriptionStatus: input.subscription.status,
    isEntitled: input.entitlement.isActive,
    entitlementRefs: input.entitlement.entitlementRefs,
    usage: input.quotaReadModel,
  };
}
