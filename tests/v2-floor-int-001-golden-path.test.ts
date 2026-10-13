import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import type { AdmittedWorker } from "../src/domain/worker-routing-policy.js";
import {
  submitOrganizationOnboardingRequest,
  admitOrganizationOnboardingRequest,
  rejectOrganizationOnboardingRequest,
} from "../src/domain/organization-onboarding.js";
import {
  createSubscriptionPlan,
  createExternalCustomerLinkageRegistry,
  createExternalSubscriptionPlanMappingRegistry,
  createPendingSubscription,
  createVerifiedSubscriptionLifecycleFact,
  applySubscriptionLifecycleFact,
  deriveEntitlement,
} from "../src/domain/subscription-entitlement.js";
import {
  projectSubscriptionUsageStatus,
  InvalidSubscriptionUsageStatusError,
} from "../src/domain/subscription-usage-status.js";

/**
 * V2-FLOOR-INT-001 (Founder "Continuous Completion Mode" continuation, this
 * session): `ORG-ONBOARD-001` (PR #141), `APP-SUB-001` (PR #140), and
 * `APP-SUB-002` (PR #147) each landed with only ISOLATED unit/boundary-scan
 * coverage - no test anywhere composed all three together end to end, even
 * though each one's own doc comments describe it as the next link in
 * exactly this chain ("an unauthenticated prospect submitted a request" ->
 * "an admitted Organization" -> a Customer in that Organization's tenant ->
 * a Subscription/Entitlement for that Customer -> a customer-safe usage
 * status view). This file is that composition witness - test-only, zero new
 * production code, mirroring this corridor's own established "golden path"
 * precedent (OS-V0-10's Golden A, OS-V1-03's cross-store isolation
 * witnesses): it does not re-prove any individual module's own already-
 * accepted adversarial floor, only that the three compose correctly and
 * that a cross-tenant substitution anywhere along the chain still fails
 * closed end to end, not just within a single module in isolation.
 *
 * Rev: Brain review correction (F1 - domain conflation, PR #147 comment
 * `6152522225`) removed `execution-quota-admission.ts`'s `QuotaReadModel`
 * from `subscription-usage-status.ts` entirely - `projectSubscriptionUsage
 * Status` now takes only `{ subscription, entitlement }` and returns a
 * `commercialUsage: "NOT_CONFIGURED"` literal rather than borrowed internal
 * quota data. GOLDEN1 and GOLDEN3 below are updated accordingly: GOLDEN1
 * no longer composes a quota scope at all, and GOLDEN3's adversarial
 * cross-tenant substitution now exercises the ENTITLEMENT argument (the
 * one fail-closed guard this module still has) instead of the now-removed
 * quotaScope argument.
 */

function elevatedWorker(): AdmittedWorker {
  return {
    workerId: "authority-golden",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:worker-eval-golden",
  };
}

function onboardOrganization(input: {
  requestId: string;
  requestedByRef: string;
  newTenantId: string;
  newOrganizationId: string;
  admittingAuthorityPrincipalRef: string;
}) {
  const request = submitOrganizationOnboardingRequest({
    requestId: input.requestId,
    requestedDisplayName: `${input.requestId} display name`,
    requestedByRef: input.requestedByRef,
    submittedAt: "2026-10-13T00:00:00.000Z",
  });
  return admitOrganizationOnboardingRequest({
    request,
    newTenantScope: createTenantScope(input.newTenantId),
    newOrganizationId: input.newOrganizationId,
    founderMembershipId: `membership-${input.newOrganizationId}`,
    admittingAuthorityPrincipalRef: input.admittingAuthorityPrincipalRef,
    evidenceRef: "internal://tests/v2-floor-int-001/onboarding-review",
    admittedAt: "2026-10-13T00:01:00.000Z",
  });
}

function activateSubscriptionAndDeriveEntitlement(input: {
  tenantId: string;
  customerId: string;
  displayName: string;
  planEntitlementRefs: ReadonlyArray<string>;
}) {
  const tenantScope = createTenantScope(input.tenantId);
  const customer = createCustomer({ tenantScope, customerId: input.customerId, displayName: input.displayName });
  const plan = createSubscriptionPlan({
    tenantScope,
    subscriptionPlanId: `plan-${input.customerId}`,
    displayName: `Plan for ${input.customerId}`,
    grantedEntitlementRefs: input.planEntitlementRefs,
  });
  const storefrontRef = "storefront.golden-path.example.com";
  const linkage = createExternalCustomerLinkageRegistry().linkOnce({
    storefrontRef,
    externalCustomerRef: `ext-${customer.customerId}`,
    tenantScope,
    customer,
    linkedAt: "2026-10-13T00:02:00.000Z",
  });
  const mapping = createExternalSubscriptionPlanMappingRegistry().admit({
    storefrontRef,
    externalProductOrVariantRef: `prod-${customer.customerId}`,
    externalSellingPlanRef: `sp-${customer.customerId}`,
    plan,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "internal://tests/v2-floor-int-001/plan-mapping",
    admittedAt: "2026-10-13T00:02:00.000Z",
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
    occurredAt: "2026-10-13T00:03:00.000Z",
    newPeriodEnd: "2026-11-13T00:00:00.000Z",
  });
  const subscription = applySubscriptionLifecycleFact(pending, activationFact);
  const entitlement = deriveEntitlement(subscription, plan);
  return { tenantScope, customer, plan, subscription, entitlement };
}

test("GOLDEN1: a prospective customer's onboarding request, once admitted, produces a real Organization/tenant that a Customer, Subscription, Entitlement, and customer-safe usage status all compose into correctly end to end", () => {
  const admission = onboardOrganization({
    requestId: "req-golden-1",
    requestedByRef: "prospect:golden-1",
    newTenantId: "tenant-golden-1",
    newOrganizationId: "org-golden-1",
    admittingAuthorityPrincipalRef: "staff:reviewer-1",
  });

  assert.equal(admission.admittedRequest.status, "ADMITTED");
  assert.equal(admission.organization.tenantId, "tenant-golden-1");
  assert.equal(admission.organization.state, "ACTIVE");
  assert.equal(admission.founderMembership.principalRef, "prospect:golden-1");
  assert.equal(admission.founderAccessRoleContext.role, "OWNER");

  // The admitted Organization's own tenantId is the exact tenant the rest of
  // the golden path (Customer -> Subscription -> Entitlement -> usage
  // status) must now operate inside - never a separately re-derived one.
  const { customer, subscription, entitlement } = activateSubscriptionAndDeriveEntitlement({
    tenantId: admission.organization.tenantId,
    customerId: "cust-golden-1",
    displayName: "Golden Customer One",
    planEntitlementRefs: ["feature:advisor", "feature:priority-support"],
  });
  assert.equal(customer.tenantId, admission.organization.tenantId);
  assert.equal(subscription.status, "ACTIVE");
  assert.equal(entitlement.isActive, true);

  const status = projectSubscriptionUsageStatus({ subscription, entitlement });

  assert.equal(status.tenantId, admission.organization.tenantId);
  assert.equal(status.customerId, customer.customerId);
  assert.equal(status.subscriptionStatus, "ACTIVE");
  assert.equal(status.isEntitled, true);
  assert.deepEqual(status.entitlementRefs, ["feature:advisor", "feature:priority-support"]);
  assert.equal(status.commercialUsage, "NOT_CONFIGURED");
});

test("GOLDEN2 (adversarial): a REJECTED onboarding request never produces an Organization/tenant - there is structurally nothing for a Customer/Subscription to attach to", () => {
  const request = submitOrganizationOnboardingRequest({
    requestId: "req-golden-2",
    requestedDisplayName: "Golden Reject Co",
    requestedByRef: "prospect:golden-2",
    submittedAt: "2026-10-13T00:00:00.000Z",
  });
  const rejected = rejectOrganizationOnboardingRequest({
    request,
    rejectingAuthorityPrincipalRef: "staff:reviewer-2",
    reason: "failed review",
    rejectedAt: "2026-10-13T00:01:00.000Z",
  });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.admittedOrganizationId, undefined);
  // No admission result, hence no organization.tenantId to even attempt to
  // build a Customer/Subscription from - this test exists to document that
  // the chain has no fallback/implicit path from REJECTED to a usable
  // tenant, not to probe a function that doesn't accept a rejected input.
  assert.throws(() =>
    admitOrganizationOnboardingRequest({
      request: rejected,
      newTenantScope: createTenantScope("tenant-golden-2"),
      newOrganizationId: "org-golden-2",
      founderMembershipId: "membership-golden-2",
      admittingAuthorityPrincipalRef: "staff:reviewer-2",
      evidenceRef: "internal://tests/v2-floor-int-001/no-resurrection",
      admittedAt: "2026-10-13T00:02:00.000Z",
    }),
  );
});

test("GOLDEN3 (adversarial): composing a Subscription from one onboarded Organization's tenant with an Entitlement derived under a DIFFERENT onboarded Organization's tenant fails closed end to end, exactly as it would within a single module", () => {
  const orgOne = onboardOrganization({
    requestId: "req-golden-3a",
    requestedByRef: "prospect:golden-3a",
    newTenantId: "tenant-golden-3a",
    newOrganizationId: "org-golden-3a",
    admittingAuthorityPrincipalRef: "staff:reviewer-3",
  });
  const orgTwo = onboardOrganization({
    requestId: "req-golden-3b",
    requestedByRef: "prospect:golden-3b",
    newTenantId: "tenant-golden-3b",
    newOrganizationId: "org-golden-3b",
    admittingAuthorityPrincipalRef: "staff:reviewer-3",
  });
  assert.notEqual(orgOne.organization.tenantId, orgTwo.organization.tenantId);

  const { subscription } = activateSubscriptionAndDeriveEntitlement({
    tenantId: orgOne.organization.tenantId,
    customerId: "cust-golden-3",
    displayName: "Golden Customer Three",
    planEntitlementRefs: ["feature:advisor"],
  });
  const { entitlement: foreignEntitlement } = activateSubscriptionAndDeriveEntitlement({
    tenantId: orgTwo.organization.tenantId,
    customerId: "cust-golden-3-foreign",
    displayName: "Golden Customer Three Foreign",
    planEntitlementRefs: ["feature:advisor"],
  });

  // An entitlement derived under the SECOND onboarded organization's tenant
  // can never compose into the FIRST organization's subscription's usage
  // status - the same fail-closed ownership check already proven inside
  // subscription-usage-status.ts's own isolated tests, now proven to still
  // hold when the tenant identity on each side of the boundary originated
  // from a real, independently-admitted onboarding flow rather than a bare
  // hand-constructed TenantScope.
  assert.throws(
    () => projectSubscriptionUsageStatus({ subscription, entitlement: foreignEntitlement }),
    InvalidSubscriptionUsageStatusError,
  );
});
