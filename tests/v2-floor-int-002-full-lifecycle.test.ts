import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import type { AdmittedWorker } from "../src/domain/worker-routing-policy.js";
import {
  submitOrganizationOnboardingRequest,
  admitOrganizationOnboardingRequest,
} from "../src/domain/organization-onboarding.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { resolveEffectiveOrganizationAccess } from "../src/domain/effective-organization-access.js";
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
import { projectSubscriptionUsageStatus } from "../src/domain/subscription-usage-status.js";
import {
  createBillingReferenceRegistry,
  InvalidBillingReferenceError,
} from "../src/domain/billing-reference.js";
import {
  requestCustomerOffboarding,
  completeCustomerOffboarding,
  CustomerOffboardingDecisionError,
} from "../src/domain/customer-offboarding.js";
import {
  startCustomerOffboardingExecution,
  advanceCustomerOffboardingExecution,
} from "../src/domain/customer-offboarding-execution.js";

/**
 * V2-FLOOR-INT-002 (Brain reconciliation on PR #145, `6152530150`, step 4 -
 * fresh-scan after CUS-OFFBOARD-002 and APP-BILL-001 shipped): mirrors
 * V2-FLOOR-INT-001's own precedent ("once more floor slices exist, prove
 * they compose") now that two more independently-landed V2 floor slices
 * exist - `APP-BILL-001` (a provider-neutral billing reference bound to a
 * real `Subscription`) and `CUS-OFFBOARD-001`/`CUS-OFFBOARD-002` (the
 * customer offboarding request/decision/execution lifecycle). Neither of
 * those two slices' own isolated test suites ever constructed its inputs
 * from a REAL onboarded `Organization`'s own tenant (both hand-build a bare
 * `TenantScope`/`Organization` directly, exactly as `APP-SUB-002` and
 * `ORG-ONBOARD-001` each did before `V2-FLOOR-INT-001` closed that same
 * gap for them). This file is the same composition witness extended one
 * layer further: a real admitted Organization -> Customer -> Subscription/
 * Entitlement/UsageStatus -> BillingReference -> CustomerOffboarding
 * request/complete -> CustomerOffboardingExecution dispositions, entirely
 * end to end inside one admitted tenant. Zero new production code; this
 * file only proves already-accepted primitives compose, mirroring every
 * prior floor-slice checkpoint's own scope discipline. No guard-disable
 * sanity round is repeated here, for the same reason `V2-FLOOR-INT-001`
 * gave: the individual fail-closed guards this composition exercises were
 * already independently confirmed load-bearing by each module's own
 * guard-disable sanity round; re-disabling the same, unmodified guards here
 * would not produce new evidence.
 */

function elevatedWorker(): AdmittedWorker {
  return {
    workerId: "authority-full-lifecycle",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:worker-eval-full-lifecycle",
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
    evidenceRef: "internal://tests/v2-floor-int-002/onboarding-review",
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
  const storefrontRef = "storefront.full-lifecycle.example.com";
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
    evidenceRef: "internal://tests/v2-floor-int-002/plan-mapping",
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

function grantedAccessInAdmittedOrganization(
  admission: ReturnType<typeof onboardOrganization>,
  decidingMembershipId: string,
) {
  const membership = createOrganizationMembership({
    membershipId: decidingMembershipId,
    tenantScope: createTenantScope(admission.organization.tenantId),
    principalRef: `principal-${decidingMembershipId}`,
    role: "STAFF",
  });
  const authority = createAuthorityContext({
    tenantScope: createTenantScope(admission.organization.tenantId),
    permissions: ["EXECUTE"],
    canPerformProtectedActions: true,
  });
  return resolveEffectiveOrganizationAccess({
    organization: admission.organization,
    membership,
    currentPrincipalRef: membership.principalRef,
    authority,
  });
}

test("FULL1: an admitted Organization's own Customer can be subscribed/entitled, billed via a provider-neutral reference, then offboarded through request/decision/execution dispositions, entirely inside one admitted tenant", () => {
  const admission = onboardOrganization({
    requestId: "req-full-1",
    requestedByRef: "prospect:full-1",
    newTenantId: "tenant-full-1",
    newOrganizationId: "org-full-1",
    admittingAuthorityPrincipalRef: "staff:reviewer-full-1",
  });
  assert.equal(admission.organization.state, "ACTIVE");

  const { customer, subscription, entitlement } = activateSubscriptionAndDeriveEntitlement({
    tenantId: admission.organization.tenantId,
    customerId: "cust-full-1",
    displayName: "Full Lifecycle Customer One",
    planEntitlementRefs: ["feature:advisor"],
  });
  assert.equal(customer.tenantId, admission.organization.tenantId);

  const status = projectSubscriptionUsageStatus({ subscription, entitlement });
  assert.equal(status.subscriptionStatus, "ACTIVE");
  assert.equal(status.isEntitled, true);

  const billingRegistry = createBillingReferenceRegistry();
  const issued = billingRegistry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-full-1",
    status: "ISSUED",
    recordedAt: "2026-10-13T00:04:00.000Z",
    evidenceRef: "internal://tests/v2-floor-int-002/billing-issued",
  });
  assert.equal(issued.tenantId, admission.organization.tenantId);
  assert.equal(issued.customerId, customer.customerId);
  const paid = billingRegistry.recordOrAdvance({
    subscription,
    externalInvoiceRef: "inv-full-1",
    status: "PAID",
    recordedAt: "2026-10-13T00:05:00.000Z",
    evidenceRef: "internal://tests/v2-floor-int-002/billing-paid",
  });
  assert.equal(paid.status, "PAID");

  const offboardingRequest = requestCustomerOffboarding({
    requestId: "offboard-full-1",
    customer,
    requestedByRef: "prospect:full-1",
    requestedAt: "2026-10-13T00:06:00.000Z",
  });
  const deciderAccess = grantedAccessInAdmittedOrganization(admission, "staff-decider-full-1");
  const { completedRequest, snapshot } = completeCustomerOffboarding({
    request: offboardingRequest,
    customer,
    currentAccess: deciderAccess,
    completedAt: "2026-10-13T00:07:00.000Z",
  });
  assert.equal(completedRequest.status, "COMPLETED");
  assert.equal(snapshot.customerId, customer.customerId);

  const executionStart = startCustomerOffboardingExecution({ completedRequest });
  assert.equal(executionStart.status, "NOT_STARTED");
  const executionDone = advanceCustomerOffboardingExecution({
    state: executionStart,
    evidenceRef: "internal://tests/v2-floor-int-002/execution-evidence",
  });
  assert.equal(executionDone.status, "COMPLETED");
  assert.equal(executionDone.resourceDispositions.length, 9);
  for (const disposition of executionDone.resourceDispositions) {
    assert.equal(
      disposition.status,
      disposition.kind === "CUSTOMER_EVIDENCE" ? "NO_AKILTA_DURABLE_RECORD" : "BLOCKED_UNSUPPORTED",
    );
  }
});

test("FULL2 (adversarial): an externalInvoiceRef already bound to one admitted Organization's Subscription cannot be claimed by a DIFFERENT admitted Organization's Subscription", () => {
  const orgOne = onboardOrganization({
    requestId: "req-full-2a",
    requestedByRef: "prospect:full-2a",
    newTenantId: "tenant-full-2a",
    newOrganizationId: "org-full-2a",
    admittingAuthorityPrincipalRef: "staff:reviewer-full-2",
  });
  const orgTwo = onboardOrganization({
    requestId: "req-full-2b",
    requestedByRef: "prospect:full-2b",
    newTenantId: "tenant-full-2b",
    newOrganizationId: "org-full-2b",
    admittingAuthorityPrincipalRef: "staff:reviewer-full-2",
  });
  assert.notEqual(orgOne.organization.tenantId, orgTwo.organization.tenantId);

  const { subscription: subscriptionOne } = activateSubscriptionAndDeriveEntitlement({
    tenantId: orgOne.organization.tenantId,
    customerId: "cust-full-2a",
    displayName: "Full Lifecycle Customer Two A",
    planEntitlementRefs: ["feature:advisor"],
  });
  const { subscription: subscriptionTwo } = activateSubscriptionAndDeriveEntitlement({
    tenantId: orgTwo.organization.tenantId,
    customerId: "cust-full-2b",
    displayName: "Full Lifecycle Customer Two B",
    planEntitlementRefs: ["feature:advisor"],
  });

  const billingRegistry = createBillingReferenceRegistry();
  billingRegistry.recordOrAdvance({
    subscription: subscriptionOne,
    externalInvoiceRef: "inv-full-shared",
    status: "ISSUED",
    recordedAt: "2026-10-13T00:04:00.000Z",
    evidenceRef: "internal://tests/v2-floor-int-002/billing-cross-a",
  });
  assert.throws(
    () =>
      billingRegistry.recordOrAdvance({
        subscription: subscriptionTwo,
        externalInvoiceRef: "inv-full-shared",
        status: "ISSUED",
        recordedAt: "2026-10-13T00:04:05.000Z",
        evidenceRef: "internal://tests/v2-floor-int-002/billing-cross-b",
      }),
    InvalidBillingReferenceError,
  );
});

test("FULL3 (adversarial): completing a customer offboarding with a decider from a DIFFERENT admitted Organization's own tenant fails closed, even though that decider holds genuinely GRANTED protected-action access in their own tenant", () => {
  const homeOrg = onboardOrganization({
    requestId: "req-full-3a",
    requestedByRef: "prospect:full-3a",
    newTenantId: "tenant-full-3a",
    newOrganizationId: "org-full-3a",
    admittingAuthorityPrincipalRef: "staff:reviewer-full-3",
  });
  const foreignOrg = onboardOrganization({
    requestId: "req-full-3b",
    requestedByRef: "prospect:full-3b",
    newTenantId: "tenant-full-3b",
    newOrganizationId: "org-full-3b",
    admittingAuthorityPrincipalRef: "staff:reviewer-full-3",
  });

  const { customer } = activateSubscriptionAndDeriveEntitlement({
    tenantId: homeOrg.organization.tenantId,
    customerId: "cust-full-3",
    displayName: "Full Lifecycle Customer Three",
    planEntitlementRefs: ["feature:advisor"],
  });
  const offboardingRequest = requestCustomerOffboarding({
    requestId: "offboard-full-3",
    customer,
    requestedByRef: "prospect:full-3",
    requestedAt: "2026-10-13T00:06:00.000Z",
  });

  // The decider's access is genuinely GRANTED with canPerformProtectedActions
  // - just bound to the FOREIGN organization's own tenant, not the request's.
  const foreignDeciderAccess = grantedAccessInAdmittedOrganization(foreignOrg, "staff-decider-full-3-foreign");
  assert.throws(
    () =>
      completeCustomerOffboarding({
        request: offboardingRequest,
        customer,
        currentAccess: foreignDeciderAccess,
        completedAt: "2026-10-13T00:07:00.000Z",
      }),
    CustomerOffboardingDecisionError,
  );
});
