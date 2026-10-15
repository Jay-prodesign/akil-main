import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer, type Customer } from "../src/domain/customer.js";
import {
  FileDurableCustomerRepository,
  CorruptedCustomerRecordFileError,
} from "../src/application/durable-customer-repository.js";

/**
 * REV216: proves the durable persistence boundary for the EXISTING
 * `CustomerRepository` port - plain upsert `save`, exact `findByTenantAndId`,
 * cross-tenant isolation, restart-safe reconstruction, and fail-closed
 * revalidation of persisted JSON (canonical-trim invariant applied from the
 * start, per `PROJ-DURABLE-001`'s own F1 correction) - mirroring every
 * other durable store in this repository's established discipline. Genuine
 * multi-process lock contention is proven separately in
 * `durable-customer-repository-concurrency.test.ts`.
 */

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "customer-repo-durable-"));
}

const TENANT = createTenantScope("tenant-customer-repo-durable");
const OTHER_TENANT = createTenantScope("tenant-customer-repo-durable-other");

function freshCustomer(customerId: string, displayName = "Durable Customer", tenantScope = TENANT): Customer {
  return createCustomer({ tenantScope, customerId, displayName });
}

test("save then findByTenantAndId returns exactly the saved customer", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-1");
    repo.save(customer);
    assert.deepEqual(repo.findByTenantAndId(TENANT, customer.customerId), customer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("save is a plain upsert - saving again with a different displayName overwrites in place", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-2", "Original Name");
    repo.save(customer);
    const updated = { ...customer, displayName: "Updated Name" };
    repo.save(updated);
    assert.equal(repo.findByTenantAndId(TENANT, customer.customerId)?.displayName, "Updated Name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findByTenantAndId returns undefined for an unknown customerId in a known tenant", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    assert.equal(repo.findByTenantAndId(TENANT, "customer-does-not-exist" as Customer["customerId"]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-tenant isolation: a different tenant's store file never sees this tenant's customers", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-3");
    repo.save(customer);
    assert.equal(repo.findByTenantAndId(OTHER_TENANT, customer.customerId), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple distinct customers in the same tenant are all independently retrievable", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const a = freshCustomer("customer-4a", "Customer A");
    const b = freshCustomer("customer-4b", "Customer B");
    repo.save(a);
    repo.save(b);
    assert.deepEqual(repo.findByTenantAndId(TENANT, a.customerId), a);
    assert.deepEqual(repo.findByTenantAndId(TENANT, b.customerId), b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart/replay reconstruction: a fresh store instance over the same baseDir sees exactly the same state", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-5");
    repo.save(customer);
    const freshInstance = new FileDurableCustomerRepository(dir);
    assert.deepEqual(freshInstance.findByTenantAndId(TENANT, customer.customerId), customer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fail-closed persisted-state validation ---

test("corrupted: a non-JSON file throws CorruptedCustomerRecordFileError", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), "{ not valid json", "utf8");
    assert.throws(() => repo.findByTenantAndId(TENANT, "customer-1" as Customer["customerId"]), CorruptedCustomerRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a JSON array instead of an object throws", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), "[]", "utf8");
    assert.throws(() => repo.findByTenantAndId(TENANT, "customer-1" as Customer["customerId"]), CorruptedCustomerRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a stored key not matching the embedded customerId throws", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-6");
    const forged = { "customer-key-mismatch": customer };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => repo.findByTenantAndId(TENANT, "customer-key-mismatch" as Customer["customerId"]), CorruptedCustomerRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: cross-tenant contamination inside the file (embedded tenantId does not match the file's own tenant) throws", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-7");
    const forged = { "customer-7": { ...customer, tenantId: OTHER_TENANT.tenantId } };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => repo.findByTenantAndId(TENANT, "customer-7" as Customer["customerId"]), CorruptedCustomerRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: an unrecognized learningEligibility value throws", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-8");
    const forged = { "customer-8": { ...customer, learningEligibility: "ACTIVE" } };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => repo.findByTenantAndId(TENANT, "customer-8" as Customer["customerId"]), CorruptedCustomerRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a displayName with leading/trailing whitespace throws", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-9");
    const forged = { "customer-9": { ...customer, displayName: " Durable Customer " } };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => repo.findByTenantAndId(TENANT, "customer-9" as Customer["customerId"]), CorruptedCustomerRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a customerId with leading/trailing whitespace throws", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-10");
    const forged = { " customer-10 ": { ...customer, customerId: " customer-10 " } };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => repo.findByTenantAndId(TENANT, " customer-10 " as Customer["customerId"]), CorruptedCustomerRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a tenantId with leading/trailing whitespace throws", () => {
  const dir = freshStoreDir();
  try {
    const repo = new FileDurableCustomerRepository(dir);
    const customer = freshCustomer("customer-11");
    const forged = { "customer-11": { ...customer, tenantId: ` ${customer.tenantId} ` } };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => repo.findByTenantAndId(TENANT, "customer-11" as Customer["customerId"]), CorruptedCustomerRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
