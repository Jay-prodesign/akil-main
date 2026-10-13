import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Subscription, Entitlement } from "./subscription-entitlement.js";

/**
 * APP-SUB-002 (AA-005 REV215 V2 floor slice continuation): the canonical OS
 * blueprint's V2 section lists "customer-facing usage/quota/credit and
 * upgrade/downgrade/suspend/cancel flows" as a required pre-GA capability.
 * `APP-SUB-001` (`subscription-entitlement.ts`) already provides the
 * subscription/entitlement lifecycle side (upgrade/downgrade via
 * `changeSubscriptionPlan`, suspend/cancel via verified
 * `SubscriptionLifecycleFact`s). This module composes that with a
 * customer-safe VIEW of the subscription - "what am I subscribed to, is it
 * active."
 *
 * Rev: BRAIN REVIEW CORRECTION (F1 - domain conflation, PR #147 comment
 * `6152522225`), independently verified before fixing. The original version
 * of this module projected `execution-quota-admission.ts`'s `QuotaReadModel`
 * as the customer-facing "usage" field. That module's own doc comment
 * frames it as internal AI/provider/tool/action execution-admission and
 * spend control - a materially different domain from customer-facing
 * commercial subscription usage/credit, and `APP-SUB-001`'s own exec-plan
 * explicitly considered and REJECTED reusing that exact module for this
 * exact reason ("that module governs internal execution/worker cost, a
 * different domain from customer-facing commercial usage - conflating them
 * would repeat the mistake `SubscriptionPlan`/`ProjectPlanVersion` already
 * deliberately avoid"). Matching tenant/customer IDs across the two domains
 * does not make their semantics equivalent; this module's original version
 * contradicted its own sibling checkpoint's explicit reasoning.
 *
 * No real customer-facing commercial usage/credit metering source exists
 * anywhere in this repository. Rather than borrow an unrelated internal
 * domain's numbers to fill that gap, `commercialUsage` is honestly
 * `"NOT_CONFIGURED"` - the single reachable literal of its own type, never
 * fabricated, never recomputed, never silently defaulted to a numeric
 * value - mirroring this repository's own established restraint for this
 * exact situation (`commercial-authority.ts`'s `CommissionLedgerStatus`,
 * single literal `"UNKNOWN"`). When a real commercial metering source is
 * later introduced, it is this module's own type that should widen to
 * describe it - never a reach back into `execution-quota-admission.ts`.
 *
 * Every other field here is read-through from an already-fail-closed
 * source; nothing is fabricated, recomputed speculatively, or defaulted
 * when a source value is absent. The only invariant this module itself
 * enforces is the fail-closed tenant/customer binding below - without it, a
 * caller could (by bug or malice) compose one customer's subscription with
 * a DIFFERENT customer's entitlement into a single status view, which
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

/**
 * No real customer-facing commercial usage/credit metering source exists
 * yet - `"NOT_CONFIGURED"` is the only reachable literal, exactly like
 * `commercial-authority.ts`'s `CommissionLedgerStatus`. This type, not
 * `execution-quota-admission.ts`'s `QuotaReadModel`, is the correct place
 * to widen once a real commercial metering source exists.
 */
export type CustomerCommercialUsageStatus = "NOT_CONFIGURED";

export interface SubscriptionUsageStatus {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly subscriptionStatus: Subscription["status"];
  readonly isEntitled: boolean;
  readonly entitlementRefs: ReadonlyArray<string>;
  readonly commercialUsage: CustomerCommercialUsageStatus;
}

/**
 * Composes an already-derived `Entitlement` into one customer-safe status
 * view for the given `subscription`. Fails closed (throws, never silently
 * substitutes or drops data) unless `entitlement` belongs to the exact same
 * tenant/customer as `subscription` - the same cross-scope ownership check
 * every other composition boundary in this repository already enforces.
 */
export function projectSubscriptionUsageStatus(input: {
  subscription: Subscription;
  entitlement: Entitlement;
}): SubscriptionUsageStatus {
  if (
    input.entitlement.tenantId !== input.subscription.tenantId ||
    input.entitlement.customerId !== input.subscription.customerId
  ) {
    throw new InvalidSubscriptionUsageStatusError(
      "entitlement must belong to the exact same tenant/customer as the subscription - a foreign or mismatched entitlement can never compose into this subscription's usage status",
    );
  }

  return {
    tenantId: input.subscription.tenantId,
    customerId: input.subscription.customerId,
    subscriptionStatus: input.subscription.status,
    isEntitled: input.entitlement.isActive,
    entitlementRefs: input.entitlement.entitlementRefs,
    commercialUsage: "NOT_CONFIGURED",
  };
}
