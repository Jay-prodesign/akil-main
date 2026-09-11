import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import {
  bootstrapExternalSaleOutcome,
  createVerifiedExternalCommerceFact,
  deriveCanonicalSaleId,
  type ExternalSaleBootstrapResult,
} from "../src/domain/external-sale-bootstrap.js";
import {
  FileDurableExternalSaleBootstrapStore,
  InvalidDurableExternalSaleBootstrapStoreError,
  CorruptedExternalSaleBootstrapLineError,
} from "../src/domain/durable-external-sale-bootstrap-store.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "sale-to-close-bootstrap-store-"));
}

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.jsonl`);
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

function bootstrapFor(tenantSuffix: string, externalOrderRef: string) {
  const { tenantScope, customer, ownership } = baseFixture(tenantSuffix);
  const connection = verifiedConnection(ownership);
  const fact = createVerifiedExternalCommerceFact({
    tenantScope,
    connection,
    externalOrderRef,
    evidenceRef: `evidence:webhook-${externalOrderRef}`,
  });
  const saleId = deriveCanonicalSaleId(fact);
  const result = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });
  return { tenantScope, customer, connection, fact, saleId, result };
}

test("S1: putIfAbsent persists a bootstrapped result exactly once; replaying the same saleId is a no-op returning the original result", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, saleId, result } = bootstrapFor("s1", "order-s1");
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    const first = store.putIfAbsent(tenantScope.tenantId, saleId, result);
    assert.equal(first.created, true);
    assert.deepEqual(first.result, result);

    const second = store.putIfAbsent(tenantScope.tenantId, saleId, result);
    assert.equal(second.created, false);
    assert.deepEqual(second.result, result);

    assert.deepEqual(store.get(tenantScope.tenantId, saleId), result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: a duplicate sale/order event (bootstrap function called twice, then persisted twice) produces no duplicate project/job - exactly one durable record", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, customer, fact, saleId } = bootstrapFor("s2", "order-s2-duplicate-delivery");
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    const firstDelivery = bootstrapExternalSaleOutcome({
      tenantScope,
      customer,
      fact,
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });
    const firstPersist = store.putIfAbsent(tenantScope.tenantId, saleId, firstDelivery);
    assert.equal(firstPersist.created, true);

    const secondDelivery = bootstrapExternalSaleOutcome({
      tenantScope,
      customer,
      fact,
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });
    const secondPersist = store.putIfAbsent(tenantScope.tenantId, saleId, secondDelivery);
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
    const { tenantScope, saleId, result } = bootstrapFor("s3", "order-s3-crash-replay");

    const storeBeforeCrash = new FileDurableExternalSaleBootstrapStore(dir);
    storeBeforeCrash.putIfAbsent(tenantScope.tenantId, saleId, result);

    const storeAfterCrash = new FileDurableExternalSaleBootstrapStore(dir);
    const replayPersist = storeAfterCrash.putIfAbsent(tenantScope.tenantId, saleId, result);

    assert.equal(replayPersist.created, false);
    assert.deepEqual(storeAfterCrash.get(tenantScope.tenantId, saleId), result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S4: claiming an already-persisted saleId with a conflicting bootstrapped result fails closed", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, saleId, result: original } = bootstrapFor("s4", "order-s4");
    const store = new FileDurableExternalSaleBootstrapStore(dir);
    store.putIfAbsent(tenantScope.tenantId, saleId, original);

    const { result: conflicting } = bootstrapFor("s4", "order-s4-different-underlying-sale");

    assert.throws(
      () => store.putIfAbsent(tenantScope.tenantId, saleId, conflicting),
      InvalidDurableExternalSaleBootstrapStoreError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S5: durable records are tenant-isolated - the same externalOrderRef string under a different tenant is a distinct, independently-stored record", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope: tenantA, ownership: ownershipA, customer: customerA } = baseFixture("s5-tenant-a");
    const { tenantScope: tenantB, ownership: ownershipB, customer: customerB } = baseFixture("s5-tenant-b");
    const connectionA = verifiedConnection(ownershipA);
    const connectionB = verifiedConnection(ownershipB);
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    const factA = createVerifiedExternalCommerceFact({
      tenantScope: tenantA,
      connection: connectionA,
      externalOrderRef: "order-shared-ref",
      evidenceRef: "evidence:x",
    });
    const factB = createVerifiedExternalCommerceFact({
      tenantScope: tenantB,
      connection: connectionB,
      externalOrderRef: "order-shared-ref",
      evidenceRef: "evidence:x",
    });
    const saleIdA = deriveCanonicalSaleId(factA);
    const saleIdB = deriveCanonicalSaleId(factB);

    const resultA = bootstrapExternalSaleOutcome({
      tenantScope: tenantA,
      customer: customerA,
      fact: factA,
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });
    const resultB = bootstrapExternalSaleOutcome({
      tenantScope: tenantB,
      customer: customerB,
      fact: factB,
      jobFamily: "WEBSITE_BUILD",
      businessObjective: "Deliver purchased website build",
    });

    store.putIfAbsent(tenantA.tenantId, saleIdA, resultA);
    store.putIfAbsent(tenantB.tenantId, saleIdB, resultB);

    assert.deepEqual(store.get(tenantA.tenantId, saleIdA), resultA);
    assert.deepEqual(store.get(tenantB.tenantId, saleIdB), resultB);
    assert.notEqual(resultA.job.tenantId, resultB.job.tenantId);
    assert.equal(store.get(tenantA.tenantId, "order-does-not-exist"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rev94 F3: fail-closed replay validation - forged/corrupt on-disk records
// ---------------------------------------------------------------------------

test("S6 (adversarial replay): a forged line that is not valid JSON fails closed on read", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope } = baseFixture("s6");
    const store = new FileDurableExternalSaleBootstrapStore(dir);
    writeFileSync(tenantFilePath(dir, tenantScope.tenantId), "{ not valid json\n", "utf8");
    assert.throws(
      () => store.get(tenantScope.tenantId, "any-sale-id"),
      CorruptedExternalSaleBootstrapLineError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S7 (adversarial replay): a forged line claiming a foreign tenant's project.tenantId under this tenant's file fails closed (cross-tenant contamination)", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, saleId, result } = bootstrapFor("s7", "order-s7");
    const store = new FileDurableExternalSaleBootstrapStore(dir);
    store.putIfAbsent(tenantScope.tenantId, saleId, result);

    const forged: ExternalSaleBootstrapResult = {
      ...result,
      project: { ...result.project, tenantId: "some-foreign-tenant" as never },
    };
    writeFileSync(
      tenantFilePath(dir, tenantScope.tenantId),
      `${JSON.stringify({ saleId, result: forged })}\n`,
      "utf8",
    );

    assert.throws(
      () => store.get(tenantScope.tenantId, saleId),
      CorruptedExternalSaleBootstrapLineError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S8 (adversarial replay): a forged line where soldScope.projectId does not match project.projectId fails closed (referential integrity)", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, saleId, result } = bootstrapFor("s8", "order-s8");
    const forged: ExternalSaleBootstrapResult = {
      ...result,
      soldScope: { ...result.soldScope, projectId: "different-project-id" as never },
    };
    writeFileSync(
      tenantFilePath(dir, tenantScope.tenantId),
      `${JSON.stringify({ saleId, result: forged })}\n`,
      "utf8",
    );
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    assert.throws(
      () => store.get(tenantScope.tenantId, saleId),
      CorruptedExternalSaleBootstrapLineError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S9 (adversarial replay): a forged line where job.projectId does not match project.projectId fails closed (referential integrity)", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, saleId, result } = bootstrapFor("s9", "order-s9");
    const forged: ExternalSaleBootstrapResult = {
      ...result,
      job: { ...result.job, projectId: "different-project-id" as never },
    };
    writeFileSync(
      tenantFilePath(dir, tenantScope.tenantId),
      `${JSON.stringify({ saleId, result: forged })}\n`,
      "utf8",
    );
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    assert.throws(
      () => store.get(tenantScope.tenantId, saleId),
      CorruptedExternalSaleBootstrapLineError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S10 (adversarial replay): a forged line with an unrecognized job.state fails closed", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, saleId, result } = bootstrapFor("s10", "order-s10");
    const forged: ExternalSaleBootstrapResult = {
      ...result,
      job: { ...result.job, state: "NOT_A_REAL_STATE" as never },
    };
    writeFileSync(
      tenantFilePath(dir, tenantScope.tenantId),
      `${JSON.stringify({ saleId, result: forged })}\n`,
      "utf8",
    );
    const store = new FileDurableExternalSaleBootstrapStore(dir);

    assert.throws(
      () => store.get(tenantScope.tenantId, saleId),
      CorruptedExternalSaleBootstrapLineError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S11 (positive replay): a legitimate persisted record still reconstructs correctly across every field after restart", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, saleId, result } = bootstrapFor("s11", "order-s11");
    const storeA = new FileDurableExternalSaleBootstrapStore(dir);
    storeA.putIfAbsent(tenantScope.tenantId, saleId, result);

    const storeB = new FileDurableExternalSaleBootstrapStore(dir);
    assert.deepEqual(storeB.get(tenantScope.tenantId, saleId), result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
