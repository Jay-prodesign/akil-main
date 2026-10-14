import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createCustomer } from "../src/domain/customer.js";
import { requestCustomerOffboarding } from "../src/domain/customer-offboarding.js";
import { FileDurableCustomerOffboardingRequestStore } from "../src/domain/durable-customer-offboarding-request-store.js";
import { createDurableCustomerOffboardingAdminSource } from "../src/web/customer-offboarding-admin-source.js";
import { resolvePendingOffboardingRequestsView } from "../src/web/internal-os-view-state.js";

/**
 * CUS-OFFBOARD-DURABLE-001: proves `createDurableCustomerOffboardingAdminSource`
 * genuinely connects `V2-ADMIN-SURFACE-001`'s `CustomerOffboardingAdminSource`
 * port to the new durable store - no longer only an abstract optional
 * source - and that `resolvePendingOffboardingRequestsView`'s own
 * independent re-verification still holds end to end over real durable
 * data.
 */

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "cus-offboard-durable-001-adapter-"));
}

test("createDurableCustomerOffboardingAdminSource surfaces real pending requests from the durable store", () => {
  const dir = freshStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-adapter-1");
    const organization: Organization = activateOrganization({
      organization: createOrganization({ organizationId: "org-adapter-1", tenantScope, displayName: "Adapter Org", createdAt: "2026-10-14T00:00:00.000Z" }),
      activatedAt: "2026-10-14T00:00:01.000Z",
    });
    const customer = createCustomer({ tenantScope, customerId: "customer-adapter-1", displayName: "Adapter Customer" });

    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const request = requestCustomerOffboarding({
      requestId: "req-adapter-1",
      customer,
      requestedByRef: "membership-requester-adapter",
      requestedAt: "2026-10-14T00:00:00.000Z",
    });
    store.createRequested(request);

    const source = createDurableCustomerOffboardingAdminSource(store);
    const results = source.listPendingRequests(organization);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.requestId, "req-adapter-1");

    const view = resolvePendingOffboardingRequestsView(organization, source);
    assert.equal(view.kind, "READY");
    if (view.kind === "READY") {
      assert.equal(view.requests.length, 1);
      assert.equal(view.requests[0]?.customerId, customer.customerId);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableCustomerOffboardingAdminSource never surfaces an already-terminal request as pending", () => {
  const dir = freshStoreDir();
  try {
    const tenantScope = createTenantScope("tenant-adapter-2");
    const organization: Organization = activateOrganization({
      organization: createOrganization({ organizationId: "org-adapter-2", tenantScope, displayName: "Adapter Org 2", createdAt: "2026-10-14T00:00:00.000Z" }),
      activatedAt: "2026-10-14T00:00:01.000Z",
    });
    const customer = createCustomer({ tenantScope, customerId: "customer-adapter-2", displayName: "Adapter Customer 2" });

    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const request = requestCustomerOffboarding({
      requestId: "req-adapter-2",
      customer,
      requestedByRef: "membership-requester-adapter-2",
      requestedAt: "2026-10-14T00:00:00.000Z",
    });
    const stored = store.createRequested(request);
    store.transitionToTerminal({
      tenantId: tenantScope.tenantId,
      requestId: stored.request.requestId,
      expectedVersion: 1,
      next: { ...stored.request, status: "COMPLETED", decidedByRef: "membership-decider-adapter", decidedAt: "2026-10-14T01:00:00.000Z" },
    });

    const source = createDurableCustomerOffboardingAdminSource(store);
    assert.equal(source.listPendingRequests(organization).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDurableCustomerOffboardingAdminSource never surfaces a different tenant's requests", () => {
  const dir = freshStoreDir();
  try {
    const tenantScopeA = createTenantScope("tenant-adapter-3a");
    const tenantScopeB = createTenantScope("tenant-adapter-3b");
    const organizationB: Organization = activateOrganization({
      organization: createOrganization({ organizationId: "org-adapter-3b", tenantScope: tenantScopeB, displayName: "Adapter Org 3B", createdAt: "2026-10-14T00:00:00.000Z" }),
      activatedAt: "2026-10-14T00:00:01.000Z",
    });
    const customerA = createCustomer({ tenantScope: tenantScopeA, customerId: "customer-adapter-3a", displayName: "Adapter Customer 3A" });

    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    store.createRequested(
      requestCustomerOffboarding({
        requestId: "req-adapter-3",
        customer: customerA,
        requestedByRef: "membership-requester-adapter-3",
        requestedAt: "2026-10-14T00:00:00.000Z",
      }),
    );

    const source = createDurableCustomerOffboardingAdminSource(store);
    assert.equal(source.listPendingRequests(organizationB).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
