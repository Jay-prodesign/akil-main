import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import {
  createOrganizationMembership,
  InvalidOrganizationMembershipTransitionError,
  type OrganizationMembership,
} from "../src/domain/organization-membership.js";
import {
  FileDurableOrganizationMembershipStore,
  OrganizationMembershipConflictError,
  OrganizationMembershipVersionConflictError,
  CorruptedOrganizationMembershipFileError,
} from "../src/domain/durable-organization-membership-store.js";

/**
 * ORG-MEMBERSHIP-DURABLE-001: proves `FileDurableOrganizationMembershipStore`
 * - create/get/listByTenant round-trip, idempotent identical-create replay,
 * create-conflict on differing content, the one-way ACTIVE -> REVOKED
 * transition under optimistic-concurrency protection (version conflict, no
 * reactivation), cross-tenant isolation, restart-reconstruction, and
 * corrupted-file fail-closed replay validation.
 */

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "durable-org-membership-"));
}

function tenantFilePath(dir: string, tenantId: TenantScope["tenantId"]): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

function membershipIn(
  tenantScope: TenantScope,
  membershipId = "mem-1",
  principalRef = "principal-1",
  role: "STAFF" | "JUNIOR" | "STUDENT" | "CLIENT_ASSOCIATE" = "STAFF",
): OrganizationMembership {
  return createOrganizationMembership({ membershipId, tenantScope, principalRef, role });
}

test("create/get/listByTenant round-trip", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-1");
    const store = new FileDurableOrganizationMembershipStore(dir);
    const membership = membershipIn(tenantScope);
    const stored = store.create(membership);
    assert.deepEqual(stored, { membership, version: 1 });

    const got = store.get(tenantScope.tenantId, membership.membershipId);
    assert.deepEqual(got, stored);

    const listed = store.listByTenant(tenantScope.tenantId);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], stored);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get on a non-existent membership returns undefined", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-2");
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.equal(store.get(tenantScope.tenantId, "mem-missing" as OrganizationMembership["membershipId"]), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create is idempotent on an exact content replay - safe no-op, never a version bump", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-3");
    const store = new FileDurableOrganizationMembershipStore(dir);
    const membership = membershipIn(tenantScope);
    const first = store.create(membership);
    const second = store.create(membership);
    assert.deepEqual(first, second);
    assert.equal(second.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects a differing record under the same membershipId - never silently overwrites or coexists", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-4");
    const store = new FileDurableOrganizationMembershipStore(dir);
    const first = createOrganizationMembership({ membershipId: "mem-1", tenantScope, principalRef: "principal-1", role: "STAFF" });
    const second = createOrganizationMembership({ membershipId: "mem-1", tenantScope, principalRef: "principal-2", role: "STAFF" });
    store.create(first);
    assert.throws(() => store.create(second), OrganizationMembershipConflictError);
    assert.deepEqual(store.get(tenantScope.tenantId, first.membershipId)?.membership, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoke transitions ACTIVE -> REVOKED, bumps version, persists revokedAt/revokedReason", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-5");
    const store = new FileDurableOrganizationMembershipStore(dir);
    const membership = membershipIn(tenantScope);
    store.create(membership);

    const revoked = store.revoke({
      tenantId: tenantScope.tenantId,
      membershipId: membership.membershipId,
      expectedVersion: 1,
      revokedAt: "2026-10-16T12:00:00.000Z",
      revokedReason: "role ended",
    });

    assert.equal(revoked.version, 2);
    assert.equal(revoked.membership.state, "REVOKED");
    assert.equal(revoked.membership.revokedAt, "2026-10-16T12:00:00.000Z");
    assert.equal(revoked.membership.revokedReason, "role ended");

    const got = store.get(tenantScope.tenantId, membership.membershipId);
    assert.deepEqual(got, revoked);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoke on a stale expectedVersion fails closed with OrganizationMembershipVersionConflictError - no mutation applied", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-6");
    const store = new FileDurableOrganizationMembershipStore(dir);
    const membership = membershipIn(tenantScope);
    store.create(membership);

    assert.throws(
      () =>
        store.revoke({
          tenantId: tenantScope.tenantId,
          membershipId: membership.membershipId,
          expectedVersion: 99,
          revokedAt: "2026-10-16T12:00:00.000Z",
          revokedReason: "role ended",
        }),
      OrganizationMembershipVersionConflictError,
    );
    assert.equal(store.get(tenantScope.tenantId, membership.membershipId)?.membership.state, "ACTIVE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoke on a non-existent membership fails closed with OrganizationMembershipVersionConflictError", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-7");
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(
      () =>
        store.revoke({
          tenantId: tenantScope.tenantId,
          membershipId: "mem-missing" as OrganizationMembership["membershipId"],
          expectedVersion: 1,
          revokedAt: "2026-10-16T12:00:00.000Z",
          revokedReason: "role ended",
        }),
      OrganizationMembershipVersionConflictError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no reactivation: revoking an already-REVOKED membership (correct version) still fails closed via revokeOrganizationMembership's own precondition", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-8");
    const store = new FileDurableOrganizationMembershipStore(dir);
    const membership = membershipIn(tenantScope);
    store.create(membership);
    const revoked = store.revoke({
      tenantId: tenantScope.tenantId,
      membershipId: membership.membershipId,
      expectedVersion: 1,
      revokedAt: "2026-10-16T12:00:00.000Z",
      revokedReason: "role ended",
    });
    assert.equal(revoked.version, 2);

    // Correct current version (2), but the record is already REVOKED -
    // revokeOrganizationMembership's own "coherent ACTIVE record" check
    // rejects the double revoke, not a version mismatch.
    assert.throws(
      () =>
        store.revoke({
          tenantId: tenantScope.tenantId,
          membershipId: membership.membershipId,
          expectedVersion: 2,
          revokedAt: "2026-10-16T13:00:00.000Z",
          revokedReason: "double revoke attempt",
        }),
      InvalidOrganizationMembershipTransitionError,
    );
    // No mutation applied: still exactly the first revocation.
    assert.deepEqual(store.get(tenantScope.tenantId, membership.membershipId), revoked);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-tenant isolation: listByTenant never leaks another tenant's memberships", () => {
  const dir = freshDir();
  try {
    const tenantA = createTenantScope("tenant-mem-a");
    const tenantB = createTenantScope("tenant-mem-b");
    const store = new FileDurableOrganizationMembershipStore(dir);
    store.create(membershipIn(tenantA, "mem-a"));
    store.create(membershipIn(tenantB, "mem-b"));

    assert.equal(store.listByTenant(tenantA.tenantId).length, 1);
    assert.equal(store.listByTenant(tenantA.tenantId)[0]?.membership.membershipId, "mem-a");
    assert.equal(store.listByTenant(tenantB.tenantId).length, 1);
    assert.equal(store.listByTenant(tenantB.tenantId)[0]?.membership.membershipId, "mem-b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart-reconstruction: a fresh store instance over the same baseDir sees every persisted record", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-9");
    const store = new FileDurableOrganizationMembershipStore(dir);
    store.create(membershipIn(tenantScope, "mem-1"));
    store.create(membershipIn(tenantScope, "mem-2", "principal-2"));
    store.revoke({
      tenantId: tenantScope.tenantId,
      membershipId: "mem-1" as OrganizationMembership["membershipId"],
      expectedVersion: 1,
      revokedAt: "2026-10-16T12:00:00.000Z",
      revokedReason: "role ended",
    });

    const freshInstance = new FileDurableOrganizationMembershipStore(dir);
    const listed = freshInstance.listByTenant(tenantScope.tenantId);
    assert.equal(listed.length, 2);
    const mem1 = listed.find((entry) => entry.membership.membershipId === "mem-1");
    const mem2 = listed.find((entry) => entry.membership.membershipId === "mem-2");
    assert.equal(mem1?.membership.state, "REVOKED");
    assert.equal(mem1?.version, 2);
    assert.equal(mem2?.membership.state, "ACTIVE");
    assert.equal(mem2?.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeCorruptedFile(dir: string, tenantScope: TenantScope, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(tenantFilePath(dir, tenantScope.tenantId), content, "utf8");
}

test("corrupted file: not valid JSON fails closed with CorruptedOrganizationMembershipFileError", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c1");
    writeCorruptedFile(dir, tenantScope, "{not json");
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: top-level content must be an object, not an array", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c2");
    writeCorruptedFile(dir, tenantScope, "[]");
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: stored key must match embedded membershipId", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c3");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "mem-wrong-key": {
          version: 1,
          membership: { membershipId: "mem-1", tenantId: tenantScope.tenantId, principalRef: "principal-1", role: "STAFF", state: "ACTIVE" },
        },
      }),
    );
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: cross-tenant contamination (embedded tenantId does not match the tenant file)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c4");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "mem-1": {
          version: 1,
          membership: { membershipId: "mem-1", tenantId: "some-other-tenant", principalRef: "principal-1", role: "STAFF", state: "ACTIVE" },
        },
      }),
    );
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: role must be one of the four recognized values", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c5");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "mem-1": {
          version: 1,
          membership: { membershipId: "mem-1", tenantId: tenantScope.tenantId, principalRef: "principal-1", role: "OWNER", state: "ACTIVE" },
        },
      }),
    );
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: ACTIVE record carrying revocation metadata is incoherent and fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c6");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "mem-1": {
          version: 1,
          membership: {
            membershipId: "mem-1",
            tenantId: tenantScope.tenantId,
            principalRef: "principal-1",
            role: "STAFF",
            state: "ACTIVE",
            revokedAt: "2026-10-16T12:00:00.000Z",
          },
        },
      }),
    );
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: REVOKED record missing revokedReason fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c7");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "mem-1": {
          version: 2,
          membership: {
            membershipId: "mem-1",
            tenantId: tenantScope.tenantId,
            principalRef: "principal-1",
            role: "STAFF",
            state: "REVOKED",
            revokedAt: "2026-10-16T12:00:00.000Z",
          },
        },
      }),
    );
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: REVOKED record with an invalid revokedAt timestamp fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c8");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "mem-1": {
          version: 2,
          membership: {
            membershipId: "mem-1",
            tenantId: tenantScope.tenantId,
            principalRef: "principal-1",
            role: "STAFF",
            state: "REVOKED",
            revokedAt: "not-a-timestamp",
            revokedReason: "role ended",
          },
        },
      }),
    );
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: canonical-trim violation on principalRef fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-mem-c9");
    writeCorruptedFile(
      dir,
      tenantScope,
      JSON.stringify({
        "mem-1": {
          version: 1,
          membership: { membershipId: "mem-1", tenantId: tenantScope.tenantId, principalRef: " principal-1 ", role: "STAFF", state: "ACTIVE" },
        },
      }),
    );
    const store = new FileDurableOrganizationMembershipStore(dir);
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
