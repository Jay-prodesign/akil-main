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
  type Subscription,
} from "../src/domain/subscription-entitlement.js";
import {
  createBillingReferenceRegistry,
  InvalidBillingReferenceError,
} from "../src/domain/billing-reference.js";

const tenantA = createTenantScope("tenant-bill-a");
const tenantB = createTenantScope("tenant-bill-b");
const customerA = createCustomer({ tenantScope: tenantA, customerId: "cust-bill-a", displayName: "Acme" });
const customerB = createCustomer({ tenantScope: tenantB, customerId: "cust-bill-b", displayName: "Globex" });

const planA = createSubscriptionPlan({
  tenantScope: tenantA,
  subscriptionPlanId: "plan-bill-a",
  displayName: "Plan A",
  grantedEntitlementRefs: ["feature:advisor"],
});
const planB = createSubscriptionPlan({
  tenantScope: tenantB,
  subscriptionPlanId: "plan-bill-b",
  displayName: "Plan B",
  grantedEntitlementRefs: ["feature:advisor"],
});

function elevatedWorker(): AdmittedWorker {
  return {
    workerId: "authority-bill",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:worker-eval-bill",
  };
}

function activeSubscriptionFor(customer: ReturnType<typeof createCustomer>, plan: ReturnType<typeof createSubscriptionPlan>): Subscription {
  const storefrontRef = "storefront.billing.example.com";
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
    evidenceRef: "internal://tests/billing-reference",
    admittedAt: "2026-10-13T00:00:00.000Z",
  });
  const pending = createPendingSubscription({
    subscriptionId: `sub-bill-${customer.customerId}`,
    customerLinkage: linkage,
    planMapping: mapping,
    externalSubscriptionContractRef: `ext-contract-${customer.customerId}`,
  });
  const activationFact = createVerifiedSubscriptionLifecycleFact({
    subscription: pending,
    storefrontRef,
    externalSubscriptionContractRef: pending.externalSubscriptionContractRef,
    externalFactRef: "ext-activate",
    factId: `f-activate-bill-${customer.customerId}`,
    factType: "ACTIVATION_VERIFIED",
    occurredAt: "2026-10-13T00:00:00.000Z",
    newPeriodEnd: "2026-11-13T00:00:00.000Z",
  });
  return applySubscriptionLifecycleFact(pending, activationFact);
}

test("B1: recording a new externalInvoiceRef against a real subscription produces a truthful ISSUED record with no amount field anywhere", () => {
  const subscription = activeSubscriptionFor(customerA, planA);
  const registry = createBillingReferenceRegistry();
  const record = registry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-001",
    status: "ISSUED",
    recordedAt: "2026-10-13T01:00:00.000Z",
    evidenceRef: "internal://tests/billing-reference/evidence-1",
  });

  assert.equal(record.tenantId, tenantA.tenantId);
  assert.equal(record.customerId, customerA.customerId);
  assert.equal(record.subscriptionId, subscription.subscriptionId);
  assert.equal(record.externalInvoiceRef, "inv-001");
  assert.equal(record.status, "ISSUED");
  assert.equal("amount" in record, false);
  assert.deepEqual(registry.resolve("inv-001"), record);
});

test("B2: an unrecognized externalInvoiceRef resolves to undefined, never a guess", () => {
  const registry = createBillingReferenceRegistry();
  assert.equal(registry.resolve("nonexistent-invoice"), undefined);
});

test("B3: an ISSUED reference can advance to PAID, and the advance is recorded with new evidence", () => {
  const subscription = activeSubscriptionFor(customerA, planA);
  const registry = createBillingReferenceRegistry();
  registry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-002",
    status: "ISSUED",
    recordedAt: "2026-10-13T01:00:00.000Z",
    evidenceRef: "internal://tests/billing-reference/evidence-issued",
  });
  const paid = registry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-002",
    status: "PAID",
    recordedAt: "2026-10-13T02:00:00.000Z",
    evidenceRef: "internal://tests/billing-reference/evidence-paid",
  });
  assert.equal(paid.status, "PAID");
  assert.equal(paid.evidenceRef, "internal://tests/billing-reference/evidence-paid");
});

test("B4: re-recording the identical status for an already-known reference is an idempotent safe no-op", () => {
  const subscription = activeSubscriptionFor(customerA, planA);
  const registry = createBillingReferenceRegistry();
  const first = registry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-003",
    status: "ISSUED",
    recordedAt: "2026-10-13T01:00:00.000Z",
    evidenceRef: "internal://tests/billing-reference/evidence-first",
  });
  const second = registry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-003",
    status: "ISSUED",
    recordedAt: "2026-10-13T09:00:00.000Z",
    evidenceRef: "internal://tests/billing-reference/evidence-DIFFERENT",
  });
  assert.deepEqual(second, first);
});

test("B5 (adversarial): an externalInvoiceRef already bound to a different subscription cannot be claimed by another subscription - cross-customer billing leak rejected fail-closed", () => {
  const subscriptionA = activeSubscriptionFor(customerA, planA);
  const subscriptionB = activeSubscriptionFor(customerB, planB);
  const registry = createBillingReferenceRegistry();
  registry.recordOrAdvance({
    subscription: subscriptionA,
    externalInvoiceRef: "inv-shared",
    status: "ISSUED",
    recordedAt: "2026-10-13T01:00:00.000Z",
    evidenceRef: "internal://tests/billing-reference/evidence-a",
  });
  assert.throws(
    () =>
      registry.recordOrAdvance({
        subscription: subscriptionB,
        externalInvoiceRef: "inv-shared",
        status: "ISSUED",
        recordedAt: "2026-10-13T01:05:00.000Z",
        evidenceRef: "internal://tests/billing-reference/evidence-b",
      }),
    InvalidBillingReferenceError,
  );
});

test("B6 (adversarial): a reference that already reached a terminal status (PAID) can never transition to a different status (FAILED) - no resurrection, no silent overwrite", () => {
  const subscription = activeSubscriptionFor(customerA, planA);
  const registry = createBillingReferenceRegistry();
  registry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-004",
    status: "ISSUED",
    recordedAt: "2026-10-13T01:00:00.000Z",
    evidenceRef: "internal://tests/billing-reference/evidence-issued-4",
  });
  registry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-004",
    status: "PAID",
    recordedAt: "2026-10-13T02:00:00.000Z",
    evidenceRef: "internal://tests/billing-reference/evidence-paid-4",
  });
  assert.throws(
    () =>
      registry.recordOrAdvance({
        subscription,
        externalInvoiceRef: "inv-004",
        status: "FAILED",
        recordedAt: "2026-10-13T03:00:00.000Z",
        evidenceRef: "internal://tests/billing-reference/evidence-failed-4",
      }),
    InvalidBillingReferenceError,
  );
});

test("B7 (adversarial): an empty externalInvoiceRef is rejected fail-closed", () => {
  const subscription = activeSubscriptionFor(customerA, planA);
  const registry = createBillingReferenceRegistry();
  assert.throws(
    () =>
      registry.recordOrAdvance({
        subscription,
        externalInvoiceRef: "   ",
        status: "ISSUED",
        recordedAt: "2026-10-13T01:00:00.000Z",
        evidenceRef: "internal://tests/billing-reference/evidence-empty",
      }),
    InvalidBillingReferenceError,
  );
});

test("B8 (boundary scan, structural): billing-reference.ts imports only from tenant-scope.js, customer.js, and subscription-entitlement.js - no authority.ts, organization-membership.ts, or execution-economics-attribution.ts coupling (no amount/cost type reused from a sibling domain)", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const content = readFileSync(join(REPO_ROOT, "src/domain/billing-reference.ts"), "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  const allowed = new Set(["./tenant-scope.js", "./customer.js", "./subscription-entitlement.js"]);
  for (const specifier of importedModules) {
    assert.ok(allowed.has(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }
  assert.doesNotMatch(content, /from ["']\.\/authority\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/organization-membership\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/execution-economics-attribution\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/execution-quota-admission\.js["']/);
});
