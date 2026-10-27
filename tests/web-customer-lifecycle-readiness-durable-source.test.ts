import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { requestCustomerOffboarding } from "../src/domain/customer-offboarding.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { FileDurableCustomerRepository } from "../src/application/durable-customer-repository.js";
import { FileDurableCustomerOffboardingRequestStore } from "../src/domain/durable-customer-offboarding-request-store.js";
import { createDurableCustomerLifecycleReadinessSource } from "../src/web/customer-lifecycle-readiness-durable-source.js";

/**
 * Gap scan N1: proves `createDurableCustomerLifecycleReadinessSource`
 * genuinely connects `CustomerLifecycleReadinessSource`
 * (`customer-lifecycle-readiness-view-state.ts`) to the real
 * `FileDurableCustomerRepository` + `FileDurableCustomerOffboardingRequestStore`
 * - no longer only an abstract, unwired port - and that the module's own
 * deterministic "which request to show" tie-break rule behaves as
 * documented, over real durable data (not mocks).
 */

function freshCustomerDir(): string {
  return mkdtempSync(join(tmpdir(), "cust-lifecycle-readiness-n1-customers-"));
}

function freshOffboardingDir(): string {
  return mkdtempSync(join(tmpdir(), "cust-lifecycle-readiness-n1-offboarding-"));
}

test("createDurableCustomerLifecycleReadinessSource: no offboarding requests at all -> NOT_REQUESTED, AVAILABLE backup, no execution status", () => {
  const customerDir = freshCustomerDir();
  const offboardingDir = freshOffboardingDir();
  try {
    const tenantScope = createTenantScope("tenant-lifecycle-1");
    const customer = createCustomer({ tenantScope, customerId: "customer-lifecycle-1", displayName: "Lifecycle Customer 1" });

    const customerRepository = new FileDurableCustomerRepository(customerDir);
    customerRepository.save(customer);
    const offboardingRequestStore = new FileDurableCustomerOffboardingRequestStore(offboardingDir);

    const source = createDurableCustomerLifecycleReadinessSource(customerRepository, offboardingRequestStore);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: "proj-lifecycle-1" });
    const projection = source.getLifecycleReadiness(ownership);

    assert.ok(projection !== undefined);
    assert.equal(projection?.backupReadiness, "AVAILABLE");
    assert.equal(projection?.offboardingStatus, "NOT_REQUESTED");
    assert.equal(projection?.offboardingExecutionStatus, undefined);
  } finally {
    rmSync(customerDir, { recursive: true, force: true });
    rmSync(offboardingDir, { recursive: true, force: true });
  }
});

test("createDurableCustomerLifecycleReadinessSource: one REQUESTED request surfaces as REQUESTED", () => {
  const customerDir = freshCustomerDir();
  const offboardingDir = freshOffboardingDir();
  try {
    const tenantScope = createTenantScope("tenant-lifecycle-2");
    const customer = createCustomer({ tenantScope, customerId: "customer-lifecycle-2", displayName: "Lifecycle Customer 2" });

    const customerRepository = new FileDurableCustomerRepository(customerDir);
    customerRepository.save(customer);
    const offboardingRequestStore = new FileDurableCustomerOffboardingRequestStore(offboardingDir);
    offboardingRequestStore.createRequested(
      requestCustomerOffboarding({
        requestId: "req-lifecycle-2",
        customer,
        requestedByRef: "membership-requester-lifecycle-2",
        requestedAt: "2026-10-14T00:00:00.000Z",
      }),
    );

    const source = createDurableCustomerLifecycleReadinessSource(customerRepository, offboardingRequestStore);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: "proj-lifecycle-2" });
    const projection = source.getLifecycleReadiness(ownership);

    assert.equal(projection?.offboardingStatus, "REQUESTED");
    assert.equal(projection?.offboardingExecutionStatus, undefined);
  } finally {
    rmSync(customerDir, { recursive: true, force: true });
    rmSync(offboardingDir, { recursive: true, force: true });
  }
});

test("createDurableCustomerLifecycleReadinessSource: one DENIED (terminal) request surfaces as DENIED", () => {
  const customerDir = freshCustomerDir();
  const offboardingDir = freshOffboardingDir();
  try {
    const tenantScope = createTenantScope("tenant-lifecycle-3");
    const customer = createCustomer({ tenantScope, customerId: "customer-lifecycle-3", displayName: "Lifecycle Customer 3" });

    const customerRepository = new FileDurableCustomerRepository(customerDir);
    customerRepository.save(customer);
    const offboardingRequestStore = new FileDurableCustomerOffboardingRequestStore(offboardingDir);
    const stored = offboardingRequestStore.createRequested(
      requestCustomerOffboarding({
        requestId: "req-lifecycle-3",
        customer,
        requestedByRef: "membership-requester-lifecycle-3",
        requestedAt: "2026-10-14T00:00:00.000Z",
      }),
    );
    offboardingRequestStore.transitionToTerminal({
      tenantId: tenantScope.tenantId,
      requestId: stored.request.requestId,
      expectedVersion: 1,
      next: {
        ...stored.request,
        status: "DENIED",
        decidedByRef: "membership-decider-lifecycle-3",
        decidedAt: "2026-10-14T01:00:00.000Z",
        denialReason: "not eligible",
      },
    });

    const source = createDurableCustomerLifecycleReadinessSource(customerRepository, offboardingRequestStore);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: "proj-lifecycle-3" });
    const projection = source.getLifecycleReadiness(ownership);

    assert.equal(projection?.offboardingStatus, "DENIED");
  } finally {
    rmSync(customerDir, { recursive: true, force: true });
    rmSync(offboardingDir, { recursive: true, force: true });
  }
});

test("createDurableCustomerLifecycleReadinessSource: a DENIED request followed by a later fresh REQUESTED request -> REQUESTED wins (rule 1)", () => {
  const customerDir = freshCustomerDir();
  const offboardingDir = freshOffboardingDir();
  try {
    const tenantScope = createTenantScope("tenant-lifecycle-4");
    const customer = createCustomer({ tenantScope, customerId: "customer-lifecycle-4", displayName: "Lifecycle Customer 4" });

    const customerRepository = new FileDurableCustomerRepository(customerDir);
    customerRepository.save(customer);
    const offboardingRequestStore = new FileDurableCustomerOffboardingRequestStore(offboardingDir);

    const firstStored = offboardingRequestStore.createRequested(
      requestCustomerOffboarding({
        requestId: "req-lifecycle-4-first",
        customer,
        requestedByRef: "membership-requester-lifecycle-4a",
        requestedAt: "2026-10-14T00:00:00.000Z",
      }),
    );
    offboardingRequestStore.transitionToTerminal({
      tenantId: tenantScope.tenantId,
      requestId: firstStored.request.requestId,
      expectedVersion: 1,
      next: {
        ...firstStored.request,
        status: "DENIED",
        decidedByRef: "membership-decider-lifecycle-4",
        decidedAt: "2026-10-14T01:00:00.000Z",
        denialReason: "not eligible yet",
      },
    });

    offboardingRequestStore.createRequested(
      requestCustomerOffboarding({
        requestId: "req-lifecycle-4-second",
        customer,
        requestedByRef: "membership-requester-lifecycle-4b",
        requestedAt: "2026-10-15T00:00:00.000Z",
      }),
    );

    const source = createDurableCustomerLifecycleReadinessSource(customerRepository, offboardingRequestStore);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: "proj-lifecycle-4" });
    const projection = source.getLifecycleReadiness(ownership);

    assert.equal(projection?.offboardingStatus, "REQUESTED");
  } finally {
    rmSync(customerDir, { recursive: true, force: true });
    rmSync(offboardingDir, { recursive: true, force: true });
  }
});

test("createDurableCustomerLifecycleReadinessSource: two terminal requests, no pending -> the most recent by requestedAt wins (rule 2)", () => {
  const customerDir = freshCustomerDir();
  const offboardingDir = freshOffboardingDir();
  try {
    const tenantScope = createTenantScope("tenant-lifecycle-5");
    const customer = createCustomer({ tenantScope, customerId: "customer-lifecycle-5", displayName: "Lifecycle Customer 5" });

    const customerRepository = new FileDurableCustomerRepository(customerDir);
    customerRepository.save(customer);
    const offboardingRequestStore = new FileDurableCustomerOffboardingRequestStore(offboardingDir);

    const olderStored = offboardingRequestStore.createRequested(
      requestCustomerOffboarding({
        requestId: "req-lifecycle-5-older",
        customer,
        requestedByRef: "membership-requester-lifecycle-5a",
        requestedAt: "2026-10-14T00:00:00.000Z",
      }),
    );
    offboardingRequestStore.transitionToTerminal({
      tenantId: tenantScope.tenantId,
      requestId: olderStored.request.requestId,
      expectedVersion: 1,
      next: {
        ...olderStored.request,
        status: "DENIED",
        decidedByRef: "membership-decider-lifecycle-5a",
        decidedAt: "2026-10-14T01:00:00.000Z",
        denialReason: "not eligible yet",
      },
    });

    const newerStored = offboardingRequestStore.createRequested(
      requestCustomerOffboarding({
        requestId: "req-lifecycle-5-newer",
        customer,
        requestedByRef: "membership-requester-lifecycle-5b",
        requestedAt: "2026-10-16T00:00:00.000Z",
      }),
    );
    offboardingRequestStore.transitionToTerminal({
      tenantId: tenantScope.tenantId,
      requestId: newerStored.request.requestId,
      expectedVersion: 1,
      next: {
        ...newerStored.request,
        status: "COMPLETED",
        decidedByRef: "membership-decider-lifecycle-5b",
        decidedAt: "2026-10-16T01:00:00.000Z",
      },
    });

    const source = createDurableCustomerLifecycleReadinessSource(customerRepository, offboardingRequestStore);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: "proj-lifecycle-5" });
    const projection = source.getLifecycleReadiness(ownership);

    assert.equal(projection?.offboardingStatus, "COMPLETED");
  } finally {
    rmSync(customerDir, { recursive: true, force: true });
    rmSync(offboardingDir, { recursive: true, force: true });
  }
});

test("createDurableCustomerLifecycleReadinessSource: a nonexistent customer returns undefined, never throws", () => {
  const customerDir = freshCustomerDir();
  const offboardingDir = freshOffboardingDir();
  try {
    const tenantScope = createTenantScope("tenant-lifecycle-6");
    const customerRepository = new FileDurableCustomerRepository(customerDir);
    const offboardingRequestStore = new FileDurableCustomerOffboardingRequestStore(offboardingDir);

    const source = createDurableCustomerLifecycleReadinessSource(customerRepository, offboardingRequestStore);
    const ownership = createProjectOwnershipRef({ tenantId: tenantScope.tenantId, customerId: "customer-ghost-6", projectId: "proj-lifecycle-6" });
    assert.equal(source.getLifecycleReadiness(ownership), undefined);
  } finally {
    rmSync(customerDir, { recursive: true, force: true });
    rmSync(offboardingDir, { recursive: true, force: true });
  }
});

test("createDurableCustomerLifecycleReadinessSource: cross-tenant isolation - same customerId under a different tenantId returns undefined", () => {
  const customerDir = freshCustomerDir();
  const offboardingDir = freshOffboardingDir();
  try {
    const tenantScopeA = createTenantScope("tenant-lifecycle-7a");
    const tenantScopeB = createTenantScope("tenant-lifecycle-7b");
    const customerA = createCustomer({ tenantScope: tenantScopeA, customerId: "customer-lifecycle-7-shared", displayName: "Lifecycle Customer 7A" });

    const customerRepository = new FileDurableCustomerRepository(customerDir);
    customerRepository.save(customerA);
    const offboardingRequestStore = new FileDurableCustomerOffboardingRequestStore(offboardingDir);
    offboardingRequestStore.createRequested(
      requestCustomerOffboarding({
        requestId: "req-lifecycle-7a",
        customer: customerA,
        requestedByRef: "membership-requester-lifecycle-7a",
        requestedAt: "2026-10-14T00:00:00.000Z",
      }),
    );

    const source = createDurableCustomerLifecycleReadinessSource(customerRepository, offboardingRequestStore);
    const foreignOwnership = createProjectOwnershipRef({
      tenantId: tenantScopeB.tenantId,
      customerId: customerA.customerId,
      projectId: "proj-lifecycle-7",
    });
    assert.equal(source.getLifecycleReadiness(foreignOwnership), undefined);
  } finally {
    rmSync(customerDir, { recursive: true, force: true });
    rmSync(offboardingDir, { recursive: true, force: true });
  }
});
