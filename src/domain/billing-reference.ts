import type { TenantScope } from "./tenant-scope.js";
import type { Customer } from "./customer.js";
import type { Subscription } from "./subscription-entitlement.js";

/**
 * APP-BILL-001 (AA-005 REV215 V2 floor slice continuation; Brain
 * reconciliation on PR #145, comment `6152530150`, step 4: "the blueprint
 * also explicitly allows billing/subscription/credit flows to be
 * implemented/tested in sandbox/internal mode for V2 readiness, so live
 * billing-provider activation is a protected gate but provider-neutral
 * billing truth/reference engineering is not automatically blocked").
 * Closes the canonical OS blueprint's V2 bullet "billing provider/payment/
 * invoice reference handling" to exactly that floor: a provider-neutral
 * record of an external billing system's own invoice/payment lifecycle,
 * bound to an already-real `Subscription` (`APP-SUB-001`).
 *
 * Deliberately carries NO monetary amount field anywhere. Two existing
 * modules in this repository each explicitly and separately declared this
 * exact restraint for this exact reason: `commercial-order.ts`'s
 * `CommercialOrder` ("No price, discount, payout, or commission field
 * exists on this type - this repository has no real commerce/payment/
 * pricing-policy integration"), and `execution-economics-attribution.ts`
 * ("Deliberately does not touch customer billing, payment/invoice/charge
 * state, quotes/prices"). Brain's own PR #147 F1 finding on this very
 * session already proved what happens when an adjacent module's amount/
 * usage type is reused outside its own declared domain - `CostAmount`
 * (from that same execution-economics module) is therefore explicitly
 * NOT reused here either, for the identical reason. If a real amount
 * ever needs to be recorded, it requires its own dedicated, explicitly-
 * scoped primitive designed at that time - never borrowed from a sibling
 * module's already-bounded domain.
 *
 * `externalInvoiceRef`/`externalPaymentRef`-shaped identifiers are opaque,
 * caller-supplied strings only - mirroring `storefrontRef`/`external
 * SubscriptionContractRef`'s own discipline in `subscription-
 * entitlement.ts`. No field anywhere in this module can hold a card
 * number, payment-method token, or gateway credential. No real billing
 * provider is named, configured, or called - every external reference is,
 * at most, a runtime value a caller supplies later from whatever sandbox/
 * internal billing flow they are testing.
 *
 * `BillingReferenceRegistry.recordOrAdvance` is the only construction/
 * mutation path, mirroring `ExternalSubscriptionPlanMappingRegistry`'s own
 * established admission discipline: an `externalInvoiceRef` fails closed
 * if it is already bound to a DIFFERENT subscription (an external invoice
 * can never be claimed by two different subscriptions - a cross-customer
 * billing leak structurally indistinguishable from this repository's other
 * composition-boundary leaks); re-recording the identical status for an
 * already-known reference is a safe idempotent no-op; once a reference
 * reaches a terminal status (`"PAID"` or `"FAILED"`), it can never
 * transition to a different status - no resurrection, no silent
 * overwrite of a settled billing fact.
 */

export class InvalidBillingReferenceError extends Error {
  constructor(reason: string) {
    super(`Invalid BillingReference operation: ${reason}`);
    this.name = "InvalidBillingReferenceError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new InvalidBillingReferenceError(`${field} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new InvalidBillingReferenceError(`${field} must not be empty or whitespace-only`);
  }
  if (value.trim() !== value) {
    throw new InvalidBillingReferenceError(`${field} must not contain leading or trailing whitespace`);
  }
  return value;
}

function requireValidTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field);
  if (Number.isNaN(Date.parse(raw))) {
    throw new InvalidBillingReferenceError(`${field} must be a valid ISO timestamp`);
  }
  return raw;
}

/** `"ISSUED"` is the only non-terminal status; `"PAID"`/`"FAILED"` are terminal and immutable once reached. */
export type BillingReferenceStatus = "ISSUED" | "PAID" | "FAILED";

function isTerminalBillingReferenceStatus(status: BillingReferenceStatus): boolean {
  return status === "PAID" || status === "FAILED";
}

export interface BillingReferenceRecord {
  readonly tenantId: TenantScope["tenantId"];
  readonly customerId: Customer["customerId"];
  readonly subscriptionId: Subscription["subscriptionId"];
  readonly externalInvoiceRef: string;
  readonly status: BillingReferenceStatus;
  readonly recordedAt: string;
  readonly evidenceRef: string;
}

export interface BillingReferenceRegistry {
  /**
   * Records a new `externalInvoiceRef` for the given `subscription`, or
   * advances an already-known one's status. Fails closed, in order:
   * (1) the reference is already bound to a DIFFERENT subscription;
   * (2) the reference already reached a terminal status and this call
   * asks for a different one. Re-recording the identical status for an
   * already-known reference is a safe no-op.
   */
  recordOrAdvance(input: {
    subscription: Subscription;
    externalInvoiceRef: unknown;
    status: BillingReferenceStatus;
    recordedAt: unknown;
    evidenceRef: unknown;
  }): BillingReferenceRecord;
  /** Fail-closed by construction: an unknown reference resolves to `undefined`, never a guess. */
  resolve(externalInvoiceRef: string): BillingReferenceRecord | undefined;
}

export function createBillingReferenceRegistry(): BillingReferenceRegistry {
  const records = new Map<string, BillingReferenceRecord>();
  return {
    recordOrAdvance(input) {
      const externalInvoiceRef = requireNonEmptyString(input.externalInvoiceRef, "externalInvoiceRef");
      const recordedAt = requireValidTimestamp(input.recordedAt, "recordedAt");
      const evidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
      const existing = records.get(externalInvoiceRef);

      if (existing !== undefined) {
        const boundToDifferentSubscription =
          existing.tenantId !== input.subscription.tenantId ||
          existing.customerId !== input.subscription.customerId ||
          existing.subscriptionId !== input.subscription.subscriptionId;
        if (boundToDifferentSubscription) {
          throw new InvalidBillingReferenceError(
            `externalInvoiceRef "${externalInvoiceRef}" is already bound to a different subscription - an external invoice reference can never be claimed by two different subscriptions`,
          );
        }
        if (isTerminalBillingReferenceStatus(existing.status) && existing.status !== input.status) {
          throw new InvalidBillingReferenceError(
            `externalInvoiceRef "${externalInvoiceRef}" already reached terminal status "${existing.status}" - it can never transition to a different status "${input.status}"`,
          );
        }
        if (existing.status === input.status) {
          return existing;
        }
        const advanced: BillingReferenceRecord = { ...existing, status: input.status, recordedAt, evidenceRef };
        records.set(externalInvoiceRef, advanced);
        return advanced;
      }

      const record: BillingReferenceRecord = {
        tenantId: input.subscription.tenantId,
        customerId: input.subscription.customerId,
        subscriptionId: input.subscription.subscriptionId,
        externalInvoiceRef,
        status: input.status,
        recordedAt,
        evidenceRef,
      };
      records.set(externalInvoiceRef, record);
      return record;
    },
    resolve(externalInvoiceRef) {
      return records.get(externalInvoiceRef);
    },
  };
}
