import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject, type Project } from "../src/domain/project.js";
import {
  FileDurableProjectStore,
  ProjectConflictError,
  ProjectVersionConflictError,
  CorruptedProjectFileError,
} from "../src/domain/durable-project-store.js";

/**
 * PROJ-DURABLE-001: proves the durable persistence boundary for `Project` -
 * create-once/idempotent-replay, fail-closed update (no stale-version
 * overwrite, no identity reassignment), exact get, customer-scoped and
 * tenant-scoped listing, restart-safe reconstruction, cross-tenant/
 * cross-customer isolation, and fail-closed revalidation of persisted JSON -
 * mirroring `durable-customer-offboarding-request-store.ts`'s own
 * established discipline. Genuine multi-process lock contention is proven
 * separately in `durable-project-store-concurrency.test.ts`.
 */

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

function compoundKeyFor(customerId: string, projectId: string): string {
  return Buffer.from(JSON.stringify([customerId, projectId]), "utf8").toString("base64url");
}

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "proj-durable-001-"));
}

const TENANT = createTenantScope("tenant-proj-durable");
const OTHER_TENANT = createTenantScope("tenant-proj-durable-other");
const CUSTOMER = createCustomer({ tenantScope: TENANT, customerId: "customer-durable-1", displayName: "Durable Customer" });
const OTHER_CUSTOMER = createCustomer({ tenantScope: TENANT, customerId: "customer-durable-2", displayName: "Other Durable Customer" });

function freshProject(projectId: string, customer = CUSTOMER, ownerRef = "membership-owner", state = "ACTIVE"): Project {
  return createProject({ tenantScope: TENANT, customer, projectId, ownerRef, state });
}

test("create creates a new record at version 1", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const stored = store.create(freshProject("proj-1"));
    assert.equal(stored.version, 1);
    assert.equal(stored.project.projectId, "proj-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create is idempotent on an exact content replay - same record, no version bump, no error", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-2");
    const first = store.create(project);
    const second = store.create(project);
    assert.deepEqual(first, second);
    assert.equal(second.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create fails closed when an existing record under the same (customerId, projectId) differs in content (collision-safe keying)", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    store.create(freshProject("proj-3", CUSTOMER, "membership-owner-a"));
    assert.throws(
      () => store.create(freshProject("proj-3", CUSTOMER, "membership-owner-b")),
      ProjectConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create never collides across different customers sharing the same bare projectId", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const a = store.create(freshProject("shared-id", CUSTOMER));
    const b = store.create(freshProject("shared-id", OTHER_CUSTOMER));
    assert.equal(a.version, 1);
    assert.equal(b.version, 1);
    assert.equal(store.get(TENANT.tenantId, CUSTOMER.customerId, "shared-id" as Project["projectId"])?.project.customerId, CUSTOMER.customerId);
    assert.equal(store.get(TENANT.tenantId, OTHER_CUSTOMER.customerId, "shared-id" as Project["projectId"])?.project.customerId, OTHER_CUSTOMER.customerId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial: compound-key encoding never collides across a customerId/projectId split that would collide under naive separator-joining", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const customerSplit = createCustomer({ tenantScope: TENANT, customerId: "cust::a", displayName: "Split Customer A" });
    const customerWhole = createCustomer({ tenantScope: TENANT, customerId: "cust", displayName: "Split Customer B" });
    const projectUnderSplit = createProject({ tenantScope: TENANT, customer: customerSplit, projectId: "b", ownerRef: "owner", state: "ACTIVE" });
    const projectUnderWhole = createProject({ tenantScope: TENANT, customer: customerWhole, projectId: "a::b", ownerRef: "owner", state: "PAUSED" });

    store.create(projectUnderSplit);
    store.create(projectUnderWhole);

    const fromSplit = store.get(TENANT.tenantId, customerSplit.customerId, projectUnderSplit.projectId);
    const fromWhole = store.get(TENANT.tenantId, customerWhole.customerId, projectUnderWhole.projectId);
    assert.equal(fromSplit?.project.state, "ACTIVE");
    assert.equal(fromWhole?.project.state, "PAUSED");
    assert.equal(store.listByTenant(TENANT.tenantId).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get/listByCustomer/listByTenant reflect real durable state", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const p1 = store.create(freshProject("proj-5"));
    store.create(freshProject("proj-6"));
    store.create(freshProject("proj-7", OTHER_CUSTOMER));

    assert.deepEqual(store.get(TENANT.tenantId, CUSTOMER.customerId, "proj-5" as Project["projectId"]), p1);
    assert.equal(store.listByCustomer(TENANT.tenantId, CUSTOMER.customerId).length, 2);
    assert.equal(store.listByCustomer(TENANT.tenantId, OTHER_CUSTOMER.customerId).length, 1);
    assert.equal(store.listByTenant(TENANT.tenantId).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update succeeds and increments version", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const stored = store.create(freshProject("proj-8", CUSTOMER, "membership-owner", "ACTIVE"));
    const updated = store.update({
      tenantId: TENANT.tenantId,
      customerId: CUSTOMER.customerId,
      projectId: stored.project.projectId,
      expectedVersion: 1,
      next: { ...stored.project, state: "PAUSED" },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.project.state, "PAUSED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update on a nonexistent project fails closed with a version conflict", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const phantom = freshProject("proj-nonexistent");
    assert.throws(
      () =>
        store.update({
          tenantId: TENANT.tenantId,
          customerId: CUSTOMER.customerId,
          projectId: phantom.projectId,
          expectedVersion: 1,
          next: { ...phantom, state: "PAUSED" },
        }),
      ProjectVersionConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial: a stale expectedVersion fails closed even though the project still exists", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const stored = store.create(freshProject("proj-9"));
    assert.throws(
      () =>
        store.update({
          tenantId: TENANT.tenantId,
          customerId: CUSTOMER.customerId,
          projectId: stored.project.projectId,
          expectedVersion: 999,
          next: { ...stored.project, state: "PAUSED" },
        }),
      ProjectVersionConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial: an update cannot reassign a project to a different customer identity", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const stored = store.create(freshProject("proj-10"));
    assert.throws(
      () =>
        store.update({
          tenantId: TENANT.tenantId,
          customerId: CUSTOMER.customerId,
          projectId: stored.project.projectId,
          expectedVersion: 1,
          next: { ...stored.project, customerId: OTHER_CUSTOMER.customerId },
        }),
      ProjectConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial: an update cannot reassign a project to a different tenant identity", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const stored = store.create(freshProject("proj-11"));
    assert.throws(
      () =>
        store.update({
          tenantId: TENANT.tenantId,
          customerId: CUSTOMER.customerId,
          projectId: stored.project.projectId,
          expectedVersion: 1,
          next: { ...stored.project, tenantId: OTHER_TENANT.tenantId },
        }),
      ProjectConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-tenant isolation: a different tenant's store file never sees this tenant's projects", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    store.create(freshProject("proj-12"));
    assert.equal(store.listByTenant(OTHER_TENANT.tenantId).length, 0);
    assert.equal(store.get(OTHER_TENANT.tenantId, CUSTOMER.customerId, "proj-12" as Project["projectId"]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart/replay reconstruction: a fresh store instance over the same baseDir sees exactly the same state", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const stored = store.create(freshProject("proj-13"));
    const updated = store.update({
      tenantId: TENANT.tenantId,
      customerId: CUSTOMER.customerId,
      projectId: stored.project.projectId,
      expectedVersion: 1,
      next: { ...stored.project, state: "PAUSED" },
    });
    const freshInstance = new FileDurableProjectStore(dir);
    assert.deepEqual(
      freshInstance.get(TENANT.tenantId, CUSTOMER.customerId, stored.project.projectId),
      updated,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fail-closed persisted-state validation ---

test("corrupted: a non-JSON file throws CorruptedProjectFileError", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), "{ not valid json", "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a JSON array instead of an object throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), "[]", "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a stored key not matching the embedded (customerId, projectId) throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const forged = {
      [compoundKeyFor(CUSTOMER.customerId, "proj-wrong-key")]: {
        version: 1,
        project: { ...freshProject("proj-different-id") },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: cross-tenant contamination inside the file (embedded tenantId does not match the file's own tenant) throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-14");
    const forged = {
      [compoundKeyFor(project.customerId, project.projectId)]: {
        version: 1,
        project: { ...project, tenantId: OTHER_TENANT.tenantId },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a non-positive-integer version throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-15");
    const forged = {
      [compoundKeyFor(project.customerId, project.projectId)]: {
        version: 0,
        project,
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: an empty ownerRef throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-16");
    const forged = {
      [compoundKeyFor(project.customerId, project.projectId)]: {
        version: 1,
        project: { ...project, ownerRef: "" },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Brain CHANGES_REQUIRED (PR #158 exact head f8391ccd8dad7459983eb2c14cfa7e504a60aa22, F1):
// canonical-trim invariant must be preserved on replay for every field,
// matching project.ts's/customer.ts's/tenant-scope.ts's own construction-time rejection. ---

test("corrupted: a projectId with leading/trailing whitespace throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-17");
    const forged = {
      [compoundKeyFor(project.customerId, project.projectId)]: {
        version: 1,
        project: { ...project, projectId: ` ${project.projectId} ` },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: an ownerRef with leading/trailing whitespace throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-18");
    const forged = {
      [compoundKeyFor(project.customerId, project.projectId)]: {
        version: 1,
        project: { ...project, ownerRef: " owner " },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a state with leading/trailing whitespace throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-19");
    const forged = {
      [compoundKeyFor(project.customerId, project.projectId)]: {
        version: 1,
        project: { ...project, state: " ACTIVE " },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a customerId with leading/trailing whitespace throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-20");
    const forged = {
      [compoundKeyFor(project.customerId, project.projectId)]: {
        version: 1,
        project: { ...project, customerId: ` ${project.customerId} ` },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted: a tenantId with leading/trailing whitespace throws", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const project = freshProject("proj-21");
    const forged = {
      [compoundKeyFor(project.customerId, project.projectId)]: {
        version: 1,
        project: { ...project, tenantId: ` ${project.tenantId} ` },
      },
    };
    writeFileSync(tenantFilePath(dir, TENANT.tenantId), JSON.stringify(forged), "utf8");
    assert.throws(() => store.listByTenant(TENANT.tenantId), CorruptedProjectFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale lock reclaim: a lock file abandoned by a crashed process is reclaimed, so a later caller succeeds quickly rather than stalling for the full lock timeout", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableProjectStore(dir);
    const safeKey = Buffer.from("akilta-tenant-stale", "utf8").toString("base64url");
    const lockPath = join(dir, ".locks", `${safeKey}.lock`);
    mkdirSync(join(dir, ".locks"), { recursive: true });
    writeFileSync(lockPath, "99999999", "utf8");
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);
    const startedAt = Date.now();
    const result = store.listByTenant(createTenantScope("akilta-tenant-stale").tenantId);
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(result, []);
    assert.ok(elapsedMs < 2000, `expected the stale lock to be reclaimed quickly, took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
