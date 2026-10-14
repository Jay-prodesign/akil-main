import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { requestCustomerOffboarding, type CustomerOffboardingRequest } from "../src/domain/customer-offboarding.js";
import {
  FileDurableCustomerOffboardingRequestStore,
  CustomerOffboardingRequestConflictError,
  CustomerOffboardingRequestVersionConflictError,
  CustomerOffboardingRequestTerminalError,
  CorruptedCustomerOffboardingRequestFileError,
  InvalidCustomerOffboardingRequestStoreError,
} from "../src/domain/durable-customer-offboarding-request-store.js";

/**
 * CUS-OFFBOARD-DURABLE-001: proves the durable persistence boundary for
 * `CustomerOffboardingRequest` - create-once/idempotent-replay, fail-closed
 * terminal transition (no resurrection, no conflicting overwrite, no
 * identity reassignment), restart-safe reconstruction, cross-tenant
 * isolation, and fail-closed revalidation of persisted JSON - mirroring
 * `durable-connector-connection-store.ts`'s own established discipline.
 * Genuine multi-process lock contention is proven separately in
 * `durable-customer-offboarding-request-store-concurrency.test.ts`.
 */

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "cus-offboard-durable-001-"));
}

const TENANT = createTenantScope("tenant-cus-offboard-durable");
const OTHER_TENANT = createTenantScope("tenant-cus-offboard-durable-other");
const CUSTOMER = createCustomer({ tenantScope: TENANT, customerId: "customer-durable-1", displayName: "Durable Customer" });
const OTHER_CUSTOMER = createCustomer({ tenantScope: TENANT, customerId: "customer-durable-2", displayName: "Other Durable Customer" });

function freshRequest(requestId: string, customer = CUSTOMER, requestedByRef = "membership-requester"): CustomerOffboardingRequest {
  return requestCustomerOffboarding({
    requestId,
    customer,
    requestedByRef,
    requestedAt: "2026-10-14T00:00:00.000Z",
  });
}

test("createRequested creates a new record at version 1", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const stored = store.createRequested(freshRequest("req-1"));
    assert.equal(stored.version, 1);
    assert.equal(stored.request.status, "REQUESTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRequested is idempotent on an exact content replay - same record, no version bump, no error", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const request = freshRequest("req-2");
    const first = store.createRequested(request);
    const second = store.createRequested(request);
    assert.deepEqual(first, second);
    assert.equal(second.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRequested fails closed when an existing record under the same requestId differs in content (collision-safe keying)", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    store.createRequested(freshRequest("req-3", CUSTOMER, "membership-requester-a"));
    assert.throws(
      () => store.createRequested(freshRequest("req-3", OTHER_CUSTOMER, "membership-requester-b")),
      CustomerOffboardingRequestConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createRequested rejects a request not already in REQUESTED status", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const terminal: CustomerOffboardingRequest = { ...freshRequest("req-4"), status: "DENIED", decidedByRef: "m", decidedAt: "2026-10-14T00:00:00.000Z", denialReason: "x" };
    assert.throws(() => store.createRequested(terminal), InvalidCustomerOffboardingRequestStoreError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get/list/listPending reflect real durable state", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const pending = store.createRequested(freshRequest("req-5"));
    store.createRequested(freshRequest("req-6"));
    const completed = store.transitionToTerminal({
      tenantId: TENANT.tenantId,
      requestId: pending.request.requestId,
      expectedVersion: 1,
      next: { ...pending.request, status: "COMPLETED", decidedByRef: "membership-decider", decidedAt: "2026-10-14T01:00:00.000Z" },
    });

    assert.deepEqual(store.get(TENANT.tenantId, pending.request.requestId), completed);
    assert.equal(store.list(TENANT.tenantId).length, 2);
    const pendingList = store.listPending(TENANT.tenantId);
    assert.equal(pendingList.length, 1);
    assert.equal(pendingList[0]?.request.requestId, "req-6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transitionToTerminal REQUESTED -> COMPLETED succeeds and increments version", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const stored = store.createRequested(freshRequest("req-7"));
    const updated = store.transitionToTerminal({
      tenantId: TENANT.tenantId,
      requestId: stored.request.requestId,
      expectedVersion: 1,
      next: { ...stored.request, status: "COMPLETED", decidedByRef: "membership-decider", decidedAt: "2026-10-14T01:00:00.000Z" },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.request.status, "COMPLETED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transitionToTerminal REQUESTED -> DENIED succeeds", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const stored = store.createRequested(freshRequest("req-8"));
    const updated = store.transitionToTerminal({
      tenantId: TENANT.tenantId,
      requestId: stored.request.requestId,
      expectedVersion: 1,
      next: { ...stored.request, status: "DENIED", decidedByRef: "membership-decider", decidedAt: "2026-10-14T01:00:00.000Z", denialReason: "not eligible" },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.request.status, "DENIED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transitionToTerminal rejects a next.status other than COMPLETED/DENIED", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const stored = store.createRequested(freshRequest("req-9"));
    assert.throws(
      () =>
        store.transitionToTerminal({
          tenantId: TENANT.tenantId,
          requestId: stored.request.requestId,
          expectedVersion: 1,
          next: stored.request,
        }),
      InvalidCustomerOffboardingRequestStoreError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transitionToTerminal on a nonexistent request fails closed with a version conflict", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const phantom = freshRequest("req-nonexistent");
    assert.throws(
      () =>
        store.transitionToTerminal({
          tenantId: TENANT.tenantId,
          requestId: phantom.requestId,
          expectedVersion: 1,
          next: { ...phantom, status: "COMPLETED", decidedByRef: "m", decidedAt: "2026-10-14T01:00:00.000Z" },
        }),
      CustomerOffboardingRequestVersionConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial: no resurrection - transitioning an already-terminal request fails closed even at the correct version", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const stored = store.createRequested(freshRequest("req-10"));
    const completed = store.transitionToTerminal({
      tenantId: TENANT.tenantId,
      requestId: stored.request.requestId,
      expectedVersion: 1,
      next: { ...stored.request, status: "COMPLETED", decidedByRef: "membership-decider", decidedAt: "2026-10-14T01:00:00.000Z" },
    });
    assert.throws(
      () =>
        store.transitionToTerminal({
          tenantId: TENANT.tenantId,
          requestId: stored.request.requestId,
          expectedVersion: completed.version,
          next: { ...completed.request, status: "DENIED", decidedByRef: "membership-decider-2", decidedAt: "2026-10-14T02:00:00.000Z", denialReason: "changed mind" },
        }),
      CustomerOffboardingRequestTerminalError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial: no conflicting terminal overwrite - a stale expectedVersion fails closed even though the request is still REQUESTED", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const stored = store.createRequested(freshRequest("req-11"));
    assert.throws(
      () =>
        store.transitionToTerminal({
          tenantId: TENANT.tenantId,
          requestId: stored.request.requestId,
          expectedVersion: 999,
          next: { ...stored.request, status: "COMPLETED", decidedByRef: "m", decidedAt: "2026-10-14T01:00:00.000Z" },
        }),
      CustomerOffboardingRequestVersionConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial: a transition cannot reassign a request to a different customer identity", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const stored = store.createRequested(freshRequest("req-12"));
    assert.throws(
      () =>
        store.transitionToTerminal({
          tenantId: TENANT.tenantId,
          requestId: stored.request.requestId,
          expectedVersion: 1,
          next: { ...stored.request, customerId: OTHER_CUSTOMER.customerId, status: "COMPLETED", decidedByRef: "m", decidedAt: "2026-10-14T01:00:00.000Z" },
        }),
      CustomerOffboardingRequestConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-tenant isolation: a different tenant's store file never sees this tenant's requests", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    store.createRequested(freshRequest("req-13"));
    assert.equal(store.list(OTHER_TENANT.tenantId).length, 0);
    assert.equal(store.get(OTHER_TENANT.tenantId, "req-13" as CustomerOffboardingRequest["requestId"]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart/replay reconstruction: a fresh store instance over the same baseDir sees exactly the same state", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const stored = store.createRequested(freshRequest("req-14"));
    const completed = store.transitionToTerminal({
      tenantId: TENANT.tenantId,
      requestId: stored.request.requestId,
      expectedVersion: 1,
      next: { ...stored.request, status: "COMPLETED", decidedByRef: "membership-decider", decidedAt: "2026-10-14T01:00:00.000Z" },
    });
    const freshInstance = new FileDurableCustomerOffboardingRequestStore(dir);
    assert.deepEqual(freshInstance.get(TENANT.tenantId, stored.request.requestId), completed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fail-closed persisted-state validation ---

test("corrupted: a non-JSON file throws CorruptedCustomerOffboardingRequestFileError", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), "{ not valid json", "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a JSON array instead of an object throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), "[]", "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a stored key not matching the embedded requestId throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const forged = {
      "req-key-mismatch": {
        version: 1,
        request: { ...freshRequest("req-different-id") },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: cross-tenant contamination inside the file (embedded tenantId does not match the file's own tenant) throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const forged = {
      "req-15": {
        version: 1,
        request: { ...freshRequest("req-15"), tenantId: OTHER_TENANT.tenantId },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: an unrecognized status value throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const forged = {
      "req-16": {
        version: 1,
        request: { ...freshRequest("req-16"), status: "NONSENSE" },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a REQUESTED record carrying a stray decision field throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const forged = {
      "req-17": {
        version: 1,
        request: { ...freshRequest("req-17"), decidedByRef: "sneaked-in" },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a COMPLETED record missing decidedAt throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const forged = {
      "req-18": {
        version: 2,
        request: { ...freshRequest("req-18"), status: "COMPLETED", decidedByRef: "m" },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a DENIED record missing denialReason throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const forged = {
      "req-19": {
        version: 2,
        request: { ...freshRequest("req-19"), status: "DENIED", decidedByRef: "m", decidedAt: "2026-10-14T01:00:00.000Z" },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a non-positive-integer version throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableCustomerOffboardingRequestStore(dir);
    const forged = {
      "req-20": {
        version: 0,
        request: { ...freshRequest("req-20") },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.list(TENANT.tenantId), CorruptedCustomerOffboardingRequestFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
