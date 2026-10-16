import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import {
  createOrganizationServicePrincipal,
  InvalidOrganizationServicePrincipalTransitionError,
  type OrganizationServicePrincipal,
} from "../src/domain/organization-service-principal.js";
import {
  FileDurableOrganizationServicePrincipalStore,
  OrganizationServicePrincipalConflictError,
  OrganizationServicePrincipalVersionConflictError,
  CorruptedOrganizationServicePrincipalFileError,
  InvalidOrganizationServicePrincipalStoreError,
} from "../src/domain/durable-organization-service-principal-store.js";

/**
 * ORG-SERVICE-PRINCIPAL-DURABLE-001: proves `FileDurableOrganizationServicePrincipalStore`
 * - create/get/listByTenant round-trip, idempotent identical-create replay,
 * create-conflict on differing content, the one-way ACTIVE -> REVOKED
 * transition under optimistic-concurrency protection (version conflict, no
 * reactivation), cross-tenant isolation, restart-reconstruction, corrupted-
 * file fail-closed replay validation, and write-boundary validation
 * (applying `ORG-MEMBERSHIP-DURABLE-001` F1's own lesson from the start).
 */

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "durable-org-service-principal-"));
}

function tenantFilePath(dir: string, tenantId: TenantScope["tenantId"]): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

function servicePrincipalIn(
  tenantScope: TenantScope,
  servicePrincipalId = "sp-1",
  workerRef = "worker-1",
): OrganizationServicePrincipal {
  return createOrganizationServicePrincipal({ servicePrincipalId, tenantScope, workerRef });
}

test("create/get/listByTenant round-trip", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-1");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const servicePrincipal = servicePrincipalIn(tenantScope);
    const stored = store.create(servicePrincipal);
    assert.deepEqual(stored, { servicePrincipal, version: 1 });

    const got = store.get(tenantScope.tenantId, servicePrincipal.servicePrincipalId);
    assert.deepEqual(got, stored);

    const listed = store.listByTenant(tenantScope.tenantId);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], stored);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get on a non-existent service principal returns undefined", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-2");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.equal(store.get(tenantScope.tenantId, "sp-missing" as OrganizationServicePrincipal["servicePrincipalId"]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create is idempotent on an exact content replay - safe no-op, never a version bump", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-3");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const servicePrincipal = servicePrincipalIn(tenantScope);
    const first = store.create(servicePrincipal);
    const second = store.create(servicePrincipal);
    assert.deepEqual(first, second);
    assert.equal(second.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects a differing record under the same servicePrincipalId - never silently overwrites or coexists", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-4");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const first = createOrganizationServicePrincipal({ servicePrincipalId: "sp-1", tenantScope, workerRef: "worker-1" });
    const second = createOrganizationServicePrincipal({ servicePrincipalId: "sp-1", tenantScope, workerRef: "worker-2" });
    store.create(first);
    assert.throws(() => store.create(second), OrganizationServicePrincipalConflictError);
    assert.deepEqual(store.get(tenantScope.tenantId, first.servicePrincipalId)?.servicePrincipal, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoke transitions ACTIVE -> REVOKED, bumps version, persists revokedAt/revokedReason", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-5");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const servicePrincipal = servicePrincipalIn(tenantScope);
    store.create(servicePrincipal);

    const revoked = store.revoke({
      tenantId: tenantScope.tenantId,
      servicePrincipalId: servicePrincipal.servicePrincipalId,
      expectedVersion: 1,
      revokedAt: "2026-10-16T12:00:00.000Z",
      revokedReason: "worker decommissioned",
    });

    assert.equal(revoked.version, 2);
    assert.equal(revoked.servicePrincipal.state, "REVOKED");
    assert.equal(revoked.servicePrincipal.revokedAt, "2026-10-16T12:00:00.000Z");
    assert.equal(revoked.servicePrincipal.revokedReason, "worker decommissioned");

    const got = store.get(tenantScope.tenantId, servicePrincipal.servicePrincipalId);
    assert.deepEqual(got, revoked);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoke on a stale expectedVersion fails closed with OrganizationServicePrincipalVersionConflictError - no mutation applied", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-6");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const servicePrincipal = servicePrincipalIn(tenantScope);
    store.create(servicePrincipal);

    assert.throws(
      () =>
        store.revoke({
          tenantId: tenantScope.tenantId,
          servicePrincipalId: servicePrincipal.servicePrincipalId,
          expectedVersion: 99,
          revokedAt: "2026-10-16T12:00:00.000Z",
          revokedReason: "worker decommissioned",
        }),
      OrganizationServicePrincipalVersionConflictError,
    );
    assert.equal(store.get(tenantScope.tenantId, servicePrincipal.servicePrincipalId)?.servicePrincipal.state, "ACTIVE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoke on a non-existent service principal fails closed with OrganizationServicePrincipalVersionConflictError", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-7");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(
      () =>
        store.revoke({
          tenantId: tenantScope.tenantId,
          servicePrincipalId: "sp-missing" as OrganizationServicePrincipal["servicePrincipalId"],
          expectedVersion: 1,
          revokedAt: "2026-10-16T12:00:00.000Z",
          revokedReason: "worker decommissioned",
        }),
      OrganizationServicePrincipalVersionConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no reactivation: revoking an already-REVOKED service principal (correct version) still fails closed via revokeOrganizationServicePrincipal's own precondition", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-8");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const servicePrincipal = servicePrincipalIn(tenantScope);
    store.create(servicePrincipal);
    const revoked = store.revoke({
      tenantId: tenantScope.tenantId,
      servicePrincipalId: servicePrincipal.servicePrincipalId,
      expectedVersion: 1,
      revokedAt: "2026-10-16T12:00:00.000Z",
      revokedReason: "worker decommissioned",
    });
    assert.equal(revoked.version, 2);

    assert.throws(
      () =>
        store.revoke({
          tenantId: tenantScope.tenantId,
          servicePrincipalId: servicePrincipal.servicePrincipalId,
          expectedVersion: 2,
          revokedAt: "2026-10-16T13:00:00.000Z",
          revokedReason: "double revoke attempt",
        }),
      InvalidOrganizationServicePrincipalTransitionError,
    );
    assert.deepEqual(store.get(tenantScope.tenantId, servicePrincipal.servicePrincipalId), revoked);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-tenant isolation: listByTenant never leaks another tenant's service principals", () => {
  const dir = freshDir();
  try {
    const tenantA = createTenantScope("tenant-sp-a");
    const tenantB = createTenantScope("tenant-sp-b");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    store.create(servicePrincipalIn(tenantA, "sp-a"));
    store.create(servicePrincipalIn(tenantB, "sp-b"));

    assert.equal(store.listByTenant(tenantA.tenantId).length, 1);
    assert.equal(store.listByTenant(tenantA.tenantId)[0]?.servicePrincipal.servicePrincipalId, "sp-a");
    assert.equal(store.listByTenant(tenantB.tenantId).length, 1);
    assert.equal(store.listByTenant(tenantB.tenantId)[0]?.servicePrincipal.servicePrincipalId, "sp-b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart-reconstruction: a fresh store instance over the same baseDir sees every persisted record", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-9");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    store.create(servicePrincipalIn(tenantScope, "sp-1"));
    store.create(servicePrincipalIn(tenantScope, "sp-2", "worker-2"));
    store.revoke({
      tenantId: tenantScope.tenantId,
      servicePrincipalId: "sp-1" as OrganizationServicePrincipal["servicePrincipalId"],
      expectedVersion: 1,
      revokedAt: "2026-10-16T12:00:00.000Z",
      revokedReason: "worker decommissioned",
    });

    const freshInstance = new FileDurableOrganizationServicePrincipalStore(dir);
    const listed = freshInstance.listByTenant(tenantScope.tenantId);
    assert.equal(listed.length, 2);
    const sp1 = listed.find((entry) => entry.servicePrincipal.servicePrincipalId === "sp-1");
    const sp2 = listed.find((entry) => entry.servicePrincipal.servicePrincipalId === "sp-2");
    assert.equal(sp1?.servicePrincipal.state, "REVOKED");
    assert.equal(sp1?.version, 2);
    assert.equal(sp2?.servicePrincipal.state, "ACTIVE");
    assert.equal(sp2?.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeCorruptedFile(dir: string, tenantScope: TenantScope, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(tenantFilePath(dir, tenantScope.tenantId), content, "utf8");
}

test("corrupted file: not valid JSON fails closed with CorruptedOrganizationServicePrincipalFileError", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-c1");
    writeCorruptedFile(dir, tenantScope, "{not json");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationServicePrincipalFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: top-level content must be an object, not an array", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-c2");
    writeCorruptedFile(dir, tenantScope, "[]");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationServicePrincipalFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: stored key must match embedded servicePrincipalId", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-c3");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "sp-wrong-key": {
          version: 1,
          servicePrincipal: { servicePrincipalId: "sp-1", tenantId: tenantScope.tenantId, workerRef: "worker-1", state: "ACTIVE" },
        },
      }),
    );
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationServicePrincipalFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: cross-tenant contamination (embedded tenantId does not match the tenant file)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-c4");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "sp-1": {
          version: 1,
          servicePrincipal: { servicePrincipalId: "sp-1", tenantId: "some-other-tenant", workerRef: "worker-1", state: "ACTIVE" },
        },
      }),
    );
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationServicePrincipalFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: ACTIVE record carrying revocation metadata is incoherent and fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-c5");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "sp-1": {
          version: 1,
          servicePrincipal: {
            servicePrincipalId: "sp-1",
            tenantId: tenantScope.tenantId,
            workerRef: "worker-1",
            state: "ACTIVE",
            revokedAt: "2026-10-16T12:00:00.000Z",
          },
        },
      }),
    );
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationServicePrincipalFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: REVOKED record missing revokedReason fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-c6");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "sp-1": {
          version: 2,
          servicePrincipal: {
            servicePrincipalId: "sp-1",
            tenantId: tenantScope.tenantId,
            workerRef: "worker-1",
            state: "REVOKED",
            revokedAt: "2026-10-16T12:00:00.000Z",
          },
        },
      }),
    );
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationServicePrincipalFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: REVOKED record with an invalid revokedAt timestamp fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-c7");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "sp-1": {
          version: 2,
          servicePrincipal: {
            servicePrincipalId: "sp-1",
            tenantId: tenantScope.tenantId,
            workerRef: "worker-1",
            state: "REVOKED",
            revokedAt: "not-a-timestamp",
            revokedReason: "worker decommissioned",
          },
        },
      }),
    );
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationServicePrincipalFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: canonical-trim violation on workerRef fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-c8");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "sp-1": {
          version: 1,
          servicePrincipal: { servicePrincipalId: "sp-1", tenantId: tenantScope.tenantId, workerRef: " worker-1 ", state: "ACTIVE" },
        },
      }),
    );
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationServicePrincipalFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Write-boundary validation (ORG-MEMBERSHIP-DURABLE-001 F1's own lesson,
// applied here from the start): `OrganizationServicePrincipal` is an
// exported structural interface, so a caller can hand `create` a value
// that never went through `createOrganizationServicePrincipal` at all.
// Each case below proves `create` rejects it BEFORE any persistence - zero
// bytes written and zero state committed.

test("write-boundary: create rejects an ACTIVE record carrying revocation metadata, zero bytes/state committed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-wb-active-revoked");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const malformed = {
      servicePrincipalId: "sp-1",
      tenantId: tenantScope.tenantId,
      workerRef: "worker-1",
      state: "ACTIVE",
      revokedAt: "2026-10-16T12:00:00.000Z",
      revokedReason: "should never be reachable through createOrganizationServicePrincipal",
    } as unknown as OrganizationServicePrincipal;

    assert.throws(() => store.create(malformed), InvalidOrganizationServicePrincipalStoreError);
    assert.equal(store.get(tenantScope.tenantId, "sp-1" as OrganizationServicePrincipal["servicePrincipalId"]), undefined);
    assert.equal(existsSync(tenantFilePath(dir, tenantScope.tenantId)), false, "no tenant file should have been written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write-boundary: create rejects a canonical-trim violation on workerRef, zero bytes/state committed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-wb-trim");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const malformed = {
      servicePrincipalId: "sp-1",
      tenantId: tenantScope.tenantId,
      workerRef: " worker-1 ",
      state: "ACTIVE",
    } as unknown as OrganizationServicePrincipal;

    assert.throws(() => store.create(malformed), InvalidOrganizationServicePrincipalStoreError);
    assert.equal(store.get(tenantScope.tenantId, "sp-1" as OrganizationServicePrincipal["servicePrincipalId"]), undefined);
    assert.equal(existsSync(tenantFilePath(dir, tenantScope.tenantId)), false, "no tenant file should have been written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write-boundary: create still accepts a genuinely well-formed service principal (no regression on the golden path)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-sp-wb-golden");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const servicePrincipal = servicePrincipalIn(tenantScope);
    const stored = store.create(servicePrincipal);
    assert.deepEqual(stored, { servicePrincipal, version: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
