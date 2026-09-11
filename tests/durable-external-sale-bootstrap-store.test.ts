import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  type ConnectionBinding,
} from "../src/domain/connection-authority.js";
import { bootstrapExternalSaleOutcome } from "../src/domain/external-sale-bootstrap.js";
import {
  FileDurableExternalSaleBootstrapStore,
  InvalidDurableExternalSaleBootstrapStoreError,
} from "../src/domain/durable-external-sale-bootstrap-store.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "sale-to-close-bootstrap-store-"));
}

function baseFixture(tenantSuffix = "a") {
  const tenantScope = createTenantScope(`tenant-store-sale-${tenantSuffix}`);
  const customer = createCustomer({
    tenantScope,
    customerId: `cust-store-sale-${tenantSuffix}`,
    displayName: "Sale Customer",
  });
  const ownership = createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: `sale-project:store-order-${tenantSuffix}`,
  });
  return { tenantScope, customer, ownership };
}

function verifiedConnection(ownership: ReturnType<typeof createProjectOwnershipRef>): ConnectionBinding {
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-store-${ownership.tenantId}`,
    ownership,
    requiredCapabilityRef: "required-access-connections",
    purpose: "vouch for external sale facts",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH2",
    validationRequirement: "provider-verified",
  });
  const requested = createConnectionBinding({
    connectionBindingId: `bind-store-${ownership.tenantId}`,
    requirement,
    ownership,
    providerRef: "SHOPIFY",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
  });
  const unverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectionBinding(unverified, "evidence:provider-handshake");
}

test("S1: putIfAbsent persists a bootstrapped result exactly once; replaying the same externalSaleRef is a no-op returning the original result", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, customer, ownership } = baseFixture("s1");
    const connection = verifiedConnection(ownership);
    const result = bootstrapExternalSaleOutcome({
      tenantScope,
      customer,
      connection,
      externalSaleRef: "order-s1",
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    const first = store.putIfAbsent(tenantScope.tenantId, "order-s1", result);
    assert.equal(first.created, true);
    assert.deepEqual(first.result, result);

    const second = store.putIfAbsent(tenantScope.tenantId, "order-s1", result);
    assert.equal(second.created, false);
    assert.deepEqual(second.result, result);

    assert.deepEqual(store.get(tenantScope.tenantId, "order-s1"), result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: a duplicate sale/order event (bootstrap function called twice, then persisted twice) produces no duplicate project/job - exactly one durable record", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, customer, ownership } = baseFixture("s2");
    const connection = verifiedConnection(ownership);
    const input = {
      tenantScope,
      customer,
      connection,
      externalSaleRef: "order-s2-duplicate-delivery",
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    };
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    // First delivery of the webhook/event.
    const firstDelivery = bootstrapExternalSaleOutcome(input);
    const firstPersist = store.putIfAbsent(
      tenantScope.tenantId,
      "order-s2-duplicate-delivery",
      firstDelivery,
    );
    assert.equal(firstPersist.created, true);

    // Provider redelivers the exact same event (at-least-once delivery).
    const secondDelivery = bootstrapExternalSaleOutcome(input);
    const secondPersist = store.putIfAbsent(
      tenantScope.tenantId,
      "order-s2-duplicate-delivery",
      secondDelivery,
    );
    assert.equal(secondPersist.created, false);
    assert.deepEqual(secondPersist.result, firstPersist.result);
    assert.equal(secondPersist.result.job.jobId, firstPersist.result.job.jobId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3: crash-then-replay converges to exactly one persisted result - a fresh store instance over the same baseDir sees the identical record with no in-memory index to diverge from disk", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, customer, ownership } = baseFixture("s3");
    const connection = verifiedConnection(ownership);
    const result = bootstrapExternalSaleOutcome({
      tenantScope,
      customer,
      connection,
      externalSaleRef: "order-s3-crash-replay",
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });

    const storeBeforeCrash = new FileDurableExternalSaleBootstrapStore(dir);
    storeBeforeCrash.putIfAbsent(tenantScope.tenantId, "order-s3-crash-replay", result);

    // Simulated crash: a brand-new process/store instance over the same
    // durable directory, then a replayed delivery of the same event.
    const storeAfterCrash = new FileDurableExternalSaleBootstrapStore(dir);
    const replayed = store2ReplayResult(tenantScope, customer, connection);
    const replayPersist = storeAfterCrash.putIfAbsent(
      tenantScope.tenantId,
      "order-s3-crash-replay",
      replayed,
    );

    assert.equal(replayPersist.created, false);
    assert.deepEqual(storeAfterCrash.get(tenantScope.tenantId, "order-s3-crash-replay"), result);

    function store2ReplayResult(
      tenantScope_: typeof tenantScope,
      customer_: typeof customer,
      connection_: typeof connection,
    ) {
      return bootstrapExternalSaleOutcome({
        tenantScope: tenantScope_,
        customer: customer_,
        connection: connection_,
        externalSaleRef: "order-s3-crash-replay",
        jobFamily: "WEBSITE_BUILD",
        businessObjective: "Deliver purchased website build",
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S4: claiming an already-persisted externalSaleRef with a conflicting bootstrapped result fails closed", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, customer, ownership } = baseFixture("s4");
    const connection = verifiedConnection(ownership);
    const store = new FileDurableExternalSaleBootstrapStore(dir);
    const original = bootstrapExternalSaleOutcome({
      tenantScope,
      customer,
      connection,
      externalSaleRef: "order-s4",
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });
    store.putIfAbsent(tenantScope.tenantId, "order-s4", original);

    const conflicting = bootstrapExternalSaleOutcome({
      tenantScope,
      customer,
      connection,
      externalSaleRef: "order-s4-different-underlying-sale",
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });

    assert.throws(
      () => store.putIfAbsent(tenantScope.tenantId, "order-s4", conflicting),
      InvalidDurableExternalSaleBootstrapStoreError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S5: durable records are tenant-isolated - the same externalSaleRef string under a different tenant is a distinct, independently-stored record", () => {
  const dir = freshStoreDir();
  try {
    const fixtureA = baseFixture("s5-tenant-a");
    const fixtureB = baseFixture("s5-tenant-b");
    const connectionA = verifiedConnection(fixtureA.ownership);
    const connectionB = verifiedConnection(fixtureB.ownership);
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    const resultA = bootstrapExternalSaleOutcome({
      tenantScope: fixtureA.tenantScope,
      customer: fixtureA.customer,
      connection: connectionA,
      externalSaleRef: "order-shared-ref",
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });
    const resultB = bootstrapExternalSaleOutcome({
      tenantScope: fixtureB.tenantScope,
      customer: fixtureB.customer,
      connection: connectionB,
      externalSaleRef: "order-shared-ref",
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });

    store.putIfAbsent(fixtureA.tenantScope.tenantId, "order-shared-ref", resultA);
    store.putIfAbsent(fixtureB.tenantScope.tenantId, "order-shared-ref", resultB);

    assert.deepEqual(store.get(fixtureA.tenantScope.tenantId, "order-shared-ref"), resultA);
    assert.deepEqual(store.get(fixtureB.tenantScope.tenantId, "order-shared-ref"), resultB);
    // Same externalSaleRef derives the same jobId under either tenant, but
    // the store still keeps them as fully separate tenant-scoped records.
    assert.notEqual(resultA.job.tenantId, resultB.job.tenantId);
    assert.equal(store.get(fixtureA.tenantScope.tenantId, "order-does-not-exist"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
