import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import type { AdmittedWorker } from "../src/domain/worker-routing-policy.js";
import {
  createSubscriptionPlan,
  createExternalCustomerLinkageRegistry,
  createExternalSubscriptionPlanMappingRegistry,
  createPendingSubscription,
  createVerifiedSubscriptionLifecycleFact,
  applySubscriptionLifecycleFact,
  deriveEntitlement,
  type Subscription,
} from "../src/domain/subscription-entitlement.js";
import {
  projectSubscriptionUsageStatus,
  InvalidSubscriptionUsageStatusError,
} from "../src/domain/subscription-usage-status.js";

/**
 * Brain review correction (F1 - domain conflation, PR #147 comment
 * `6152522225`): this file no longer imports or composes
 * `execution-quota-admission.ts`'s `QuotaReadModel`/`QuotaAdmissionScope` -
 * that module is internal execution-admission, a different domain from
 * customer-facing commercial usage, per APP-SUB-001's own rejected-reuse
 * reasoning. U5-U7 and the quota-scope fixtures these tests previously
 * exercised are removed accordingly; U5 is a new, narrower test replacing
 * them (commercialUsage is always the single NOT_CONFIGURED literal).
 */

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

function elevatedWorker(): AdmittedWorker {
  return {
    workerId: "authority-1",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:worker-eval-1",
  };
}

function activeSubscriptionFor(customer: ReturnType<typeof createCustomer>, plan: ReturnType<typeof createSubscriptionPlan>): Subscription {
  const storefrontRef = "storefront.example.com";
  const linkage = createExternalCustomerLinkageRegistry().linkOnce({
    storefrontRef,
    externalCustomerRef: `ext-${customer.customerId}`,
    tenantScope: createTenantScope(customer.tenantId),
    customer,
    linkedAt: "2026-10-13T00:00:00.000Z",
  });
  const mapping = createExternalSubscriptionPlanMappingRegistry().admit({
    storefrontRef,
    externalProductOrVariantRef: `prod-${customer.customerId}`,
    externalSellingPlanRef: `sp-${customer.customerId}`,
    plan,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "internal://tests/subscription-usage-status",
    admittedAt: "2026-10-13T00:00:00.000Z",
  });
  const pending = createPendingSubscription({
    subscriptionId: `sub-${customer.customerId}`,
    customerLinkage: linkage,
    planMapping: mapping,
    externalSubscriptionContractRef: `ext-contract-${customer.customerId}`,
  });
  const activationFact = createVerifiedSubscriptionLifecycleFact({
    subscription: pending,
    storefrontRef,
    externalSubscriptionContractRef: pending.externalSubscriptionContractRef,
    externalFactRef: "ext-activate",
    factId: `f-activate-${customer.customerId}`,
    factType: "ACTIVATION_VERIFIED",
    occurredAt: "2026-10-13T00:00:00.000Z",
    newPeriodEnd: "2026-11-13T00:00:00.000Z",
  });
  return applySubscriptionLifecycleFact(pending, activationFact);
}

test("U1: a subscription and its own entitlement compose into one truthful customer-safe usage status", () => {
  const subscription = activeSubscriptionFor(customerA, planA);
  const entitlement = deriveEntitlement(subscription, planA);

  const status = projectSubscriptionUsageStatus({ subscription, entitlement });

  assert.equal(status.tenantId, tenantA.tenantId);
  assert.equal(status.customerId, customerA.customerId);
  assert.equal(status.subscriptionStatus, "ACTIVE");
  assert.equal(status.isEntitled, true);
  assert.deepEqual(status.entitlementRefs, ["feature:advisor", "feature:priority-support"]);
  assert.equal(status.commercialUsage, "NOT_CONFIGURED");
});

test("U2: a non-activated subscription composes with isEntitled false and empty entitlementRefs - never fabricated", () => {
  const storefrontRef = "storefront.example.com";
  const linkage = createExternalCustomerLinkageRegistry().linkOnce({
    storefrontRef,
    externalCustomerRef: "ext-pending",
    tenantScope: tenantA,
    customer: customerA,
    linkedAt: "2026-10-13T00:00:00.000Z",
  });
  const mapping = createExternalSubscriptionPlanMappingRegistry().admit({
    storefrontRef,
    externalProductOrVariantRef: "prod-pending",
    externalSellingPlanRef: "sp-pending",
    plan: planA,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "internal://tests/subscription-usage-status-pending",
    admittedAt: "2026-10-13T00:00:00.000Z",
  });
  const pending = createPendingSubscription({
    subscriptionId: "sub-pending",
    customerLinkage: linkage,
    planMapping: mapping,
    externalSubscriptionContractRef: "ext-contract-pending",
  });
  const entitlement = deriveEntitlement(pending, planA);

  const status = projectSubscriptionUsageStatus({ subscription: pending, entitlement });
  assert.equal(status.subscriptionStatus, "PENDING_ACTIVATION");
  assert.equal(status.isEntitled, false);
  assert.deepEqual(status.entitlementRefs, []);
  assert.equal(status.commercialUsage, "NOT_CONFIGURED");
});

test("U3 (adversarial): an entitlement belonging to a different tenant is rejected fail-closed, never silently composed", () => {
  const subscriptionA = activeSubscriptionFor(customerA, planA);
  const planB = createSubscriptionPlan({
    tenantScope: tenantB,
    subscriptionPlanId: "plan-pro-b",
    displayName: "Pro B",
    grantedEntitlementRefs: ["feature:advisor"],
  });
  const subscriptionB = activeSubscriptionFor(customerB, planB);
  const foreignEntitlement = deriveEntitlement(subscriptionB, planB);

  assert.throws(
    () => projectSubscriptionUsageStatus({ subscription: subscriptionA, entitlement: foreignEntitlement }),
    InvalidSubscriptionUsageStatusError,
  );
});

test("U4 (adversarial): an entitlement belonging to a different customer within the SAME tenant is rejected fail-closed", () => {
  const subscriptionA = activeSubscriptionFor(customerA, planA);
  const subscriptionA2 = activeSubscriptionFor(customerA2, planA);
  const foreignEntitlement = deriveEntitlement(subscriptionA2, planA);

  assert.throws(
    () => projectSubscriptionUsageStatus({ subscription: subscriptionA, entitlement: foreignEntitlement }),
    InvalidSubscriptionUsageStatusError,
  );
});

test("U5: commercialUsage is always exactly the single NOT_CONFIGURED literal - never a fabricated numeric value, regardless of subscription state", () => {
  const subscriptionA = activeSubscriptionFor(customerA, planA);
  const entitlement = deriveEntitlement(subscriptionA, planA);
  const status = projectSubscriptionUsageStatus({ subscription: subscriptionA, entitlement });
  assert.equal(status.commercialUsage, "NOT_CONFIGURED");
  assert.equal(typeof status.commercialUsage, "string");
});

test("B1 (boundary scan, structural): subscription-usage-status.ts imports only from subscription-entitlement.js, tenant-scope.js, and customer.js - no authority.ts, organization-membership.ts, or execution-quota-admission.ts coupling, no new runtime dependency", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const content = readFileSync(join(REPO_ROOT, "src/domain/subscription-usage-status.ts"), "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const allowed = new Set(["./tenant-scope.js", "./customer.js", "./subscription-entitlement.js"]);
  for (const specifier of importedModules) {
    assert.ok(allowed.has(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
  assert.doesNotMatch(content, /from ["']\.\/authority\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/organization-membership\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/execution-quota-admission\.js["']/);
});
