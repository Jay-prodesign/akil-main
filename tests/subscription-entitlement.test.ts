import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import {
  createSubscriptionPlan,
  createShopifyCustomerLinkageRegistry,
  createShopifySubscriptionPlanMappingRegistry,
  createPendingSubscription,
  applySubscriptionLifecycleFact,
  reconstructSubscription,
  deriveEntitlement,
  AmbiguousShopifyCustomerLinkageError,
  ShopifySubscriptionPlanMappingAlreadyAdmittedError,
  InvalidSubscriptionEntitlementError,
  type SubscriptionLifecycleFact,
} from "../src/domain/subscription-entitlement.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");
const customerA = createCustomer({ tenantScope: tenantA, customerId: "cust-a", displayName: "Acme" });
const customerA2 = createCustomer({ tenantScope: tenantA, customerId: "cust-a2", displayName: "Acme Sibling" });
const customerB = createCustomer({ tenantScope: tenantB, customerId: "cust-b", displayName: "Globex" });

const planA = createSubscriptionPlan({
  tenantScope: tenantA,
  subscriptionPlanId: "plan-pro",
  displayName: "Pro",
  grantedEntitlementRefs: ["feature:advisor", "feature:priority-support"],
});

function fact(overrides: Partial<SubscriptionLifecycleFact> & { factId: string; factType: SubscriptionLifecycleFact["factType"] }): SubscriptionLifecycleFact {
  return { occurredAt: "2026-09-17T00:00:00.000Z", externalFactRef: "ext-ref", ...overrides };
}

test("S1: a SubscriptionPlan is bound to its own tenant and carries only non-empty granted entitlement refs", () => {
  assert.equal(planA.tenantId, tenantA.tenantId);
  assert.deepEqual(planA.grantedEntitlementRefs, ["feature:advisor", "feature:priority-support"]);
});

test("S2 (trusted customer mapping): linkOnce is idempotent for the identical (shop, shopifyCustomerId, tenant, customer) tuple", () => {
  const registry = createShopifyCustomerLinkageRegistry();
  const first = registry.linkOnce({ shopDomain: "shop.myshopify.com", shopifyCustomerId: "sc-1", tenantScope: tenantA, customer: customerA, linkedAt: "2026-09-17T00:00:00.000Z" });
  const second = registry.linkOnce({ shopDomain: "shop.myshopify.com", shopifyCustomerId: "sc-1", tenantScope: tenantA, customer: customerA, linkedAt: "2026-09-17T00:00:00.000Z" });
  assert.deepEqual(first, second);
});

test("S3 (ambiguous external identity rejection): re-linking the same Shopify customer to a different AKILTA customer fails closed", () => {
  const registry = createShopifyCustomerLinkageRegistry();
  registry.linkOnce({ shopDomain: "shop.myshopify.com", shopifyCustomerId: "sc-2", tenantScope: tenantA, customer: customerA, linkedAt: "2026-09-17T00:00:00.000Z" });
  assert.throws(
    () => registry.linkOnce({ shopDomain: "shop.myshopify.com", shopifyCustomerId: "sc-2", tenantScope: tenantA, customer: customerA2, linkedAt: "2026-09-17T00:00:00.000Z" }),
    AmbiguousShopifyCustomerLinkageError,
  );
});

test("S4 (ambiguous external identity rejection, cross-tenant): re-linking the same Shopify customer to a different AKILTA tenant fails closed", () => {
  const registry = createShopifyCustomerLinkageRegistry();
  registry.linkOnce({ shopDomain: "shop.myshopify.com", shopifyCustomerId: "sc-3", tenantScope: tenantA, customer: customerA, linkedAt: "2026-09-17T00:00:00.000Z" });
  assert.throws(
    () => registry.linkOnce({ shopDomain: "shop.myshopify.com", shopifyCustomerId: "sc-3", tenantScope: tenantB, customer: customerB, linkedAt: "2026-09-17T00:00:00.000Z" }),
    AmbiguousShopifyCustomerLinkageError,
  );
});

test("S5 (fail-closed on missing mapping): resolve() returns undefined for an unmapped Shopify customer, never a guess", () => {
  const registry = createShopifyCustomerLinkageRegistry();
  assert.equal(registry.resolve("shop.myshopify.com", "sc-does-not-exist"), undefined);
});

test("S6 (collision-safe customer-linkage key): two distinct (shopDomain, shopifyCustomerId) tuples whose components straddle the raw delimiter never collide", () => {
  const registry = createShopifyCustomerLinkageRegistry();
  // Old-style `${shopDomain}::${shopifyCustomerId}` would collide for these two tuples.
  const shopDomainA = "a::b";
  const shopifyCustomerIdA = "c";
  const shopDomainB = "a";
  const shopifyCustomerIdB = "b::c";
  const oldKey = (shop: string, cust: string) => `${shop}::${cust}`;
  assert.equal(oldKey(shopDomainA, shopifyCustomerIdA), oldKey(shopDomainB, shopifyCustomerIdB));

  registry.linkOnce({ shopDomain: shopDomainA, shopifyCustomerId: shopifyCustomerIdA, tenantScope: tenantA, customer: customerA, linkedAt: "2026-09-17T00:00:00.000Z" });
  registry.linkOnce({ shopDomain: shopDomainB, shopifyCustomerId: shopifyCustomerIdB, tenantScope: tenantB, customer: customerB, linkedAt: "2026-09-17T00:00:00.000Z" });

  assert.equal(registry.resolve(shopDomainA, shopifyCustomerIdA)?.customerId, customerA.customerId);
  assert.equal(registry.resolve(shopDomainB, shopifyCustomerIdB)?.customerId, customerB.customerId);
});

test("S7 (trusted plan mapping): admit is idempotent for the identical mapping and immutable against a different SubscriptionPlan", () => {
  const registry = createShopifySubscriptionPlanMappingRegistry();
  const admitInput = {
    shopDomain: "shop.myshopify.com",
    shopifyProductOrVariantId: "prod-1",
    shopifySellingPlanId: "sp-1",
    plan: planA,
    admittedByAuthorityId: "founder-1",
    evidenceRef: "internal://tests/plan-mapping",
    admittedAt: "2026-09-17T00:00:00.000Z",
  };
  const first = registry.admit(admitInput);
  const second = registry.admit(admitInput);
  assert.deepEqual(first, second);

  const otherPlan = createSubscriptionPlan({
    tenantScope: tenantA,
    subscriptionPlanId: "plan-basic",
    displayName: "Basic",
    grantedEntitlementRefs: [],
  });
  assert.throws(
    () => registry.admit({ ...admitInput, plan: otherPlan }),
    ShopifySubscriptionPlanMappingAlreadyAdmittedError,
  );
});

test("S8: an OutcomeJobExecutionNotRoutedError-style fail-closed default - resolve() on an unadmitted plan mapping returns undefined", () => {
  const registry = createShopifySubscriptionPlanMappingRegistry();
  assert.equal(registry.resolve("shop.myshopify.com", "prod-none", "sp-none"), undefined);
});

function admittedLinkageAndMapping() {
  const customerLinkageRegistry = createShopifyCustomerLinkageRegistry();
  const linkage = customerLinkageRegistry.linkOnce({
    shopDomain: "shop.myshopify.com",
    shopifyCustomerId: "sc-100",
    tenantScope: tenantA,
    customer: customerA,
    linkedAt: "2026-09-17T00:00:00.000Z",
  });
  const planMappingRegistry = createShopifySubscriptionPlanMappingRegistry();
  const mapping = planMappingRegistry.admit({
    shopDomain: "shop.myshopify.com",
    shopifyProductOrVariantId: "prod-100",
    shopifySellingPlanId: "sp-100",
    plan: planA,
    admittedByAuthorityId: "founder-1",
    evidenceRef: "internal://tests/plan-mapping-100",
    admittedAt: "2026-09-17T00:00:00.000Z",
  });
  return { linkage, mapping };
}

test("S9: createPendingSubscription derives tenant/customer/plan identity only from resolved trusted linkage/mapping objects, never raw caller strings, and is always born PENDING_ACTIVATION", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const subscription = createPendingSubscription({
    subscriptionId: "sub-1",
    customerLinkage: linkage,
    planMapping: mapping,
    shopifySubscriptionContractRef: "shopify-contract-1",
  });
  assert.equal(subscription.status, "PENDING_ACTIVATION");
  assert.equal(subscription.tenantId, tenantA.tenantId);
  assert.equal(subscription.customerId, customerA.customerId);
  assert.equal(subscription.subscriptionPlanId, planA.subscriptionPlanId);
});

test("S10 (checkout intent/unverified never activates): with no ACTIVATION_VERIFIED fact ever applied, the subscription remains PENDING_ACTIVATION and entitlement is inactive", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const subscription = createPendingSubscription({
    subscriptionId: "sub-2",
    customerLinkage: linkage,
    planMapping: mapping,
    shopifySubscriptionContractRef: "shopify-contract-2",
  });
  assert.equal(subscription.status, "PENDING_ACTIVATION");
  const entitlement = deriveEntitlement(subscription, planA);
  assert.equal(entitlement.isActive, false);
  assert.deepEqual(entitlement.entitlementRefs, []);
});

test("S11 (verified activation): a genuine ACTIVATION_VERIFIED fact activates the subscription and grants the plan's entitlements", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({
    subscriptionId: "sub-3",
    customerLinkage: linkage,
    planMapping: mapping,
    shopifySubscriptionContractRef: "shopify-contract-3",
  });
  const activated = applySubscriptionLifecycleFact(
    pending,
    fact({ factId: "f-activate-1", factType: "ACTIVATION_VERIFIED", newPeriodEnd: "2026-10-17T00:00:00.000Z" }),
  );
  assert.equal(activated.status, "ACTIVE");
  assert.equal(activated.currentPeriodEnd, "2026-10-17T00:00:00.000Z");
  const entitlement = deriveEntitlement(activated, planA);
  assert.equal(entitlement.isActive, true);
  assert.deepEqual(entitlement.entitlementRefs, planA.grantedEntitlementRefs);
});

test("S12 (renewal): a RENEWAL_VERIFIED fact keeps the subscription ACTIVE and advances currentPeriodEnd", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-4", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-4" });
  const activated = applySubscriptionLifecycleFact(pending, fact({ factId: "f-activate", factType: "ACTIVATION_VERIFIED", newPeriodEnd: "2026-10-17T00:00:00.000Z" }));
  const renewed = applySubscriptionLifecycleFact(activated, fact({ factId: "f-renew", factType: "RENEWAL_VERIFIED", newPeriodEnd: "2026-11-17T00:00:00.000Z" }));
  assert.equal(renewed.status, "ACTIVE");
  assert.equal(renewed.currentPeriodEnd, "2026-11-17T00:00:00.000Z");
});

test("S13 (payment failure/past-due revokes entitlement): a PAYMENT_FAILED fact moves ACTIVE to PAST_DUE and entitlement becomes inactive", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-5", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-5" });
  const activated = applySubscriptionLifecycleFact(pending, fact({ factId: "f-activate", factType: "ACTIVATION_VERIFIED" }));
  const pastDue = applySubscriptionLifecycleFact(activated, fact({ factId: "f-fail", factType: "PAYMENT_FAILED" }));
  assert.equal(pastDue.status, "PAST_DUE");
  assert.equal(deriveEntitlement(pastDue, planA).isActive, false);
});

test("S14 (payment recovery restores entitlement): a PAYMENT_RECOVERED fact after PAST_DUE restores ACTIVE and entitlement", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-6", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-6" });
  const activated = applySubscriptionLifecycleFact(pending, fact({ factId: "f-activate", factType: "ACTIVATION_VERIFIED" }));
  const pastDue = applySubscriptionLifecycleFact(activated, fact({ factId: "f-fail", factType: "PAYMENT_FAILED" }));
  const recovered = applySubscriptionLifecycleFact(pastDue, fact({ factId: "f-recover", factType: "PAYMENT_RECOVERED" }));
  assert.equal(recovered.status, "ACTIVE");
  assert.equal(deriveEntitlement(recovered, planA).isActive, true);
});

test("S15 (cancellation revocation): a CANCELED fact from ACTIVE is terminal and revokes entitlement", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-7", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-7" });
  const activated = applySubscriptionLifecycleFact(pending, fact({ factId: "f-activate", factType: "ACTIVATION_VERIFIED" }));
  const canceled = applySubscriptionLifecycleFact(activated, fact({ factId: "f-cancel", factType: "CANCELED" }));
  assert.equal(canceled.status, "CANCELED");
  assert.equal(deriveEntitlement(canceled, planA).isActive, false);
  // Terminal: a further fact never moves it out of CANCELED.
  const afterRecover = applySubscriptionLifecycleFact(canceled, fact({ factId: "f-recover-after-cancel", factType: "PAYMENT_RECOVERED" }));
  assert.equal(afterRecover.status, "CANCELED");
});

test("S16 (expiry revocation): an EXPIRED fact from PAST_DUE is terminal and revokes entitlement", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-8", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-8" });
  const activated = applySubscriptionLifecycleFact(pending, fact({ factId: "f-activate", factType: "ACTIVATION_VERIFIED" }));
  const pastDue = applySubscriptionLifecycleFact(activated, fact({ factId: "f-fail", factType: "PAYMENT_FAILED" }));
  const expired = applySubscriptionLifecycleFact(pastDue, fact({ factId: "f-expire", factType: "EXPIRED" }));
  assert.equal(expired.status, "EXPIRED");
  assert.equal(deriveEntitlement(expired, planA).isActive, false);
});

test("S17 (pause/resume): PAUSED then RESUMED returns to ACTIVE", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-9", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-9" });
  const activated = applySubscriptionLifecycleFact(pending, fact({ factId: "f-activate", factType: "ACTIVATION_VERIFIED" }));
  const paused = applySubscriptionLifecycleFact(activated, fact({ factId: "f-pause", factType: "PAUSED" }));
  assert.equal(paused.status, "PAUSED");
  assert.equal(deriveEntitlement(paused, planA).isActive, false);
  const resumed = applySubscriptionLifecycleFact(paused, fact({ factId: "f-resume", factType: "RESUMED" }));
  assert.equal(resumed.status, "ACTIVE");
});

test("S18 (duplicate/replay safety): applying the identical factId twice is a no-op", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-10", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-10" });
  const activateFact = fact({ factId: "f-activate-dup", factType: "ACTIVATION_VERIFIED", newPeriodEnd: "2026-10-17T00:00:00.000Z" });
  const once = applySubscriptionLifecycleFact(pending, activateFact);
  const twice = applySubscriptionLifecycleFact(once, activateFact);
  assert.deepEqual(once, twice);
});

test("S19 (replay safety against regression - the load-bearing case): replaying a stale PAYMENT_FAILED fact after a later PAYMENT_RECOVERED fact never regresses the subscription", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-11", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-11" });
  const activated = applySubscriptionLifecycleFact(pending, fact({ factId: "f-activate", factType: "ACTIVATION_VERIFIED" }));
  const failFact = fact({ factId: "f-fail", factType: "PAYMENT_FAILED" });
  const pastDue = applySubscriptionLifecycleFact(activated, failFact);
  const recovered = applySubscriptionLifecycleFact(pastDue, fact({ factId: "f-recover", factType: "PAYMENT_RECOVERED" }));
  assert.equal(recovered.status, "ACTIVE");
  // A stale replay of the original PAYMENT_FAILED fact (e.g. duplicate webhook delivery) must not regress ACTIVE back to PAST_DUE.
  const replayed = applySubscriptionLifecycleFact(recovered, failFact);
  assert.equal(replayed.status, "ACTIVE");
});

test("S20 (reconstruction proves restart-safety): reconstructSubscription over a full fact log produces the identical state as incremental application", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-12", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-12" });
  const facts: ReadonlyArray<SubscriptionLifecycleFact> = [
    fact({ factId: "f1", factType: "ACTIVATION_VERIFIED", newPeriodEnd: "2026-10-17T00:00:00.000Z" }),
    fact({ factId: "f2", factType: "PAYMENT_FAILED" }),
    fact({ factId: "f3", factType: "PAYMENT_RECOVERED" }),
  ];
  const incremental = facts.reduce(applySubscriptionLifecycleFact, pending);
  const reconstructed = reconstructSubscription(pending, facts);
  assert.deepEqual(incremental, reconstructed);
  assert.equal(reconstructed.status, "ACTIVE");
});

test("S21 (tenant isolation): deriveEntitlement rejects a plan from a different tenant than the subscription", () => {
  const { linkage, mapping } = admittedLinkageAndMapping();
  const pending = createPendingSubscription({ subscriptionId: "sub-13", customerLinkage: linkage, planMapping: mapping, shopifySubscriptionContractRef: "shopify-contract-13" });
  const activated = applySubscriptionLifecycleFact(pending, fact({ factId: "f-activate", factType: "ACTIVATION_VERIFIED" }));
  const foreignPlan = createSubscriptionPlan({
    tenantScope: tenantB,
    subscriptionPlanId: "plan-pro",
    displayName: "Pro (tenant B)",
    grantedEntitlementRefs: ["feature:advisor"],
  });
  assert.throws(() => deriveEntitlement(activated, foreignPlan), InvalidSubscriptionEntitlementError);
});

test("S22 (cross-shop rejection): createPendingSubscription rejects a linkage/mapping pair from different Shopify shops", () => {
  const customerLinkageRegistry = createShopifyCustomerLinkageRegistry();
  const linkage = customerLinkageRegistry.linkOnce({
    shopDomain: "shop-one.myshopify.com",
    shopifyCustomerId: "sc-x",
    tenantScope: tenantA,
    customer: customerA,
    linkedAt: "2026-09-17T00:00:00.000Z",
  });
  const planMappingRegistry = createShopifySubscriptionPlanMappingRegistry();
  const mapping = planMappingRegistry.admit({
    shopDomain: "shop-two.myshopify.com",
    shopifyProductOrVariantId: "prod-x",
    shopifySellingPlanId: "sp-x",
    plan: planA,
    admittedByAuthorityId: "founder-1",
    evidenceRef: "internal://tests/cross-shop",
    admittedAt: "2026-09-17T00:00:00.000Z",
  });
  assert.throws(
    () =>
      createPendingSubscription({
        subscriptionId: "sub-14",
        customerLinkage: linkage,
        planMapping: mapping,
        shopifySubscriptionContractRef: "shopify-contract-14",
      }),
    InvalidSubscriptionEntitlementError,
  );
});
