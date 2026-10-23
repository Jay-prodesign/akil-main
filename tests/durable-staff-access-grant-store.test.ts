import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import { createAuthorityContext, type AuthorityContext, type Permission } from "../src/domain/authority.js";
import {
  createAssignmentReference,
  createOrganizationMembership,
  type OrganizationMembership,
} from "../src/domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import {
  FileDurableStaffAccessGrantStore,
  StaffAccessGrantConflictError,
  StaffAccessGrantVersionConflictError,
  CorruptedStaffAccessGrantFileError,
  InvalidStaffAccessGrantStoreError,
  type StaffAccessGrantRecord,
} from "../src/domain/durable-staff-access-grant-store.js";

/**
 * C2: proves `FileDurableStaffAccessGrantStore` - create/get/listByTenant
 * round-trip (including the `ReadonlySet<Permission>` <-> array
 * serialization), idempotent identical-create replay, create conflict on
 * differing content, `update` under optimistic concurrency, cross-tenant
 * isolation, restart reconstruction, the shared write-boundary coherence
 * check (zero bytes committed on rejection), and fail-closed replay
 * validation of corrupted files.
 */

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "durable-staff-access-grant-"));
}

function tenantFilePath(dir: string, tenantId: TenantScope["tenantId"]): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

function membershipIn(tenantScope: TenantScope, membershipId = "mem-1", principalRef = "principal-1"): OrganizationMembership {
  return createOrganizationMembership({ membershipId, tenantScope, principalRef, role: "STAFF" });
}

function authorityIn(
  tenantScope: TenantScope,
  permissions: ReadonlyArray<Permission> = ["READ"],
  canPerformProtectedActions = false,
): AuthorityContext {
  return createAuthorityContext({ tenantScope, permissions, canPerformProtectedActions });
}

function grantFor(
  membership: OrganizationMembership,
  options: { permissions?: ReadonlyArray<Permission>; withAssignment?: boolean; withRole?: boolean } = {},
): StaffAccessGrantRecord {
  const tenantScope = createTenantScope(membership.tenantId);
  return {
    tenantId: membership.tenantId,
    membershipId: membership.membershipId,
    authority: authorityIn(tenantScope, options.permissions ?? ["READ"]),
    assignments:
      options.withAssignment === true
        ? [createAssignmentReference({ assignmentId: "asg-1", membership, customerId: "cust-1", projectId: "proj-1" })]
        : [],
    ...(options.withRole === true ? { roleContext: createOrganizationAccessRoleContext({ membership, role: "ADMIN" }) } : {}),
  };
}

/** A well-formed on-disk record, for corruption tests to damage one field at a time. */
function rawRecord(tenantId: string, membershipId = "mem-1"): Record<string, unknown> {
  return {
    version: 1,
    grant: {
      tenantId,
      membershipId,
      authority: { permissions: ["READ"], canPerformProtectedActions: false },
      assignments: [{ assignmentId: "asg-1", tenantId, membershipId, customerId: "cust-1", projectId: "proj-1" }],
      roleContext: { tenantId, membershipId, principalRef: "principal-1", role: "ADMIN" },
    },
  };
}

function withCorruptedRecord(
  mutate: (record: Record<string, unknown>, grant: Record<string, unknown>) => void,
  expectedMessage: RegExp,
): void {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-corrupt");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const record = rawRecord(tenantScope.tenantId);
    mutate(record, record["grant"] as Record<string, unknown>);
    writeFileSync(tenantFilePath(dir, tenantScope.tenantId), JSON.stringify({ "mem-1": record }), "utf8");
    assert.throws(
      () => store.listByTenant(tenantScope.tenantId),
      (error: unknown) => error instanceof CorruptedStaffAccessGrantFileError && expectedMessage.test(error.message),
    );
    assert.throws(() => store.get(tenantScope.tenantId, "mem-1" as never), CorruptedStaffAccessGrantFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("create/get/listByTenant round-trip preserves the permission Set, assignments and role context", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-1");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const grant = grantFor(membershipIn(tenantScope), { permissions: ["READ", "WRITE"], withAssignment: true, withRole: true });
    const stored = store.create(grant);
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.grant, grant);
    assert.ok(stored.grant.authority.permissions instanceof Set);
    assert.deepEqual([...stored.grant.authority.permissions].sort(), ["READ", "WRITE"]);

    assert.deepEqual(store.get(tenantScope.tenantId, grant.membershipId), stored);
    const listed = store.listByTenant(tenantScope.tenantId);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], stored);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on disk, permissions are a plain array in the fixed READ, WRITE, EXECUTE order (never a `{}`-serialized Set)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-2");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const grant = grantFor(membershipIn(tenantScope), { permissions: ["EXECUTE", "READ", "WRITE"] });
    store.create(grant);
    const onDisk = JSON.parse(readFileSync(tenantFilePath(dir, tenantScope.tenantId), "utf8")) as Record<
      string,
      { grant: { authority: { permissions: unknown } } }
    >;
    assert.deepEqual(onDisk["mem-1"]?.grant.authority.permissions, ["READ", "WRITE", "EXECUTE"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("get on a membership with no grant record returns undefined - no default grant", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-3");
    const store = new FileDurableStaffAccessGrantStore(dir);
    assert.equal(store.get(tenantScope.tenantId, "mem-missing" as never), undefined);
    assert.deepEqual(store.listByTenant(tenantScope.tenantId), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a role context is stored as given and never widens permissions - an ADMIN/OWNER role with no permissions round-trips with none", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-4");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    const grant: StaffAccessGrantRecord = {
      ...grantFor(membership, { permissions: [] }),
      roleContext: createOrganizationAccessRoleContext({ membership, role: "OWNER" }),
    };
    store.create(grant);
    const read = store.get(tenantScope.tenantId, membership.membershipId);
    assert.equal(read?.grant.authority.permissions.size, 0);
    assert.equal(read?.grant.authority.canPerformProtectedActions, false);
    assert.equal(read?.grant.roleContext?.role, "OWNER");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create is idempotent on an exact replay, including the same permissions in a different Set insertion order", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-5");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    const first = store.create(grantFor(membership, { permissions: ["READ", "WRITE"] }));
    const second = store.create(grantFor(membership, { permissions: ["WRITE", "READ"] }));
    assert.deepEqual(first, second);
    assert.equal(second.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects a grant whose permissions differ from the stored one (a Set would JSON.stringify both as `{}`)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-6");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    store.create(grantFor(membership, { permissions: ["READ"] }));
    assert.throws(() => store.create(grantFor(membership, { permissions: ["READ", "WRITE"] })), StaffAccessGrantConflictError);
    assert.deepEqual([...(store.get(tenantScope.tenantId, membership.membershipId)?.grant.authority.permissions ?? [])], ["READ"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update replaces the grant at the expected version and bumps the version", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-7");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    store.create(grantFor(membership, { permissions: ["READ"] }));
    const next = grantFor(membership, { permissions: ["READ", "WRITE"], withAssignment: true });
    const updated = store.update({ tenantId: tenantScope.tenantId, membershipId: membership.membershipId, expectedVersion: 1, next });
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.grant, next);
    assert.deepEqual(new FileDurableStaffAccessGrantStore(dir).get(tenantScope.tenantId, membership.membershipId), updated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update on a stale expectedVersion fails closed with StaffAccessGrantVersionConflictError - nothing applied", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-8");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    store.create(grantFor(membership, { permissions: ["READ"] }));
    assert.throws(
      () =>
        store.update({
          tenantId: tenantScope.tenantId,
          membershipId: membership.membershipId,
          expectedVersion: 7,
          next: grantFor(membership, { permissions: ["READ", "WRITE", "EXECUTE"] }),
        }),
      StaffAccessGrantVersionConflictError,
    );
    const current = store.get(tenantScope.tenantId, membership.membershipId);
    assert.equal(current?.version, 1);
    assert.deepEqual([...(current?.grant.authority.permissions ?? [])], ["READ"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update on a membership with no grant record fails closed - update never creates", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-9");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    assert.throws(
      () => store.update({ tenantId: tenantScope.tenantId, membershipId: membership.membershipId, expectedVersion: 1, next: grantFor(membership) }),
      StaffAccessGrantVersionConflictError,
    );
    assert.equal(store.get(tenantScope.tenantId, membership.membershipId), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update can never move a grant to a different membership", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-10");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    store.create(grantFor(membership));
    const other = membershipIn(tenantScope, "mem-2", "principal-2");
    assert.throws(
      () => store.update({ tenantId: tenantScope.tenantId, membershipId: membership.membershipId, expectedVersion: 1, next: grantFor(other) }),
      StaffAccessGrantConflictError,
    );
    assert.equal(store.get(tenantScope.tenantId, membership.membershipId)?.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-tenant isolation: the same membershipId in two tenants is two independent records", () => {
  const dir = freshDir();
  try {
    const tenantA = createTenantScope("tenant-grant-a");
    const tenantB = createTenantScope("tenant-grant-b");
    const store = new FileDurableStaffAccessGrantStore(dir);
    store.create(grantFor(membershipIn(tenantA), { permissions: ["READ", "WRITE"] }));
    assert.equal(store.get(tenantB.tenantId, "mem-1" as never), undefined);
    assert.deepEqual(store.listByTenant(tenantB.tenantId), []);
    store.create(grantFor(membershipIn(tenantB), { permissions: ["READ"] }));
    assert.equal(store.get(tenantA.tenantId, "mem-1" as never)?.grant.authority.permissions.size, 2);
    assert.equal(store.get(tenantB.tenantId, "mem-1" as never)?.grant.authority.permissions.size, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart reconstruction: a fresh store instance over the same baseDir sees every persisted grant", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-11");
    const first = new FileDurableStaffAccessGrantStore(dir);
    first.create(grantFor(membershipIn(tenantScope, "mem-1", "principal-1"), { withAssignment: true, withRole: true }));
    first.create(grantFor(membershipIn(tenantScope, "mem-2", "principal-2"), { permissions: ["READ", "EXECUTE"] }));
    const reopened = new FileDurableStaffAccessGrantStore(dir);
    assert.deepEqual(reopened.listByTenant(tenantScope.tenantId), first.listByTenant(tenantScope.tenantId));
    assert.equal(reopened.listByTenant(tenantScope.tenantId).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function assertRejectedAtWriteBoundary(build: (tenantScope: TenantScope, membership: OrganizationMembership) => StaffAccessGrantRecord): void {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-write-boundary");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    assert.throws(() => store.create(build(tenantScope, membership)), InvalidStaffAccessGrantStoreError);
    assert.equal(existsSync(tenantFilePath(dir, tenantScope.tenantId)), false, "a rejected create must commit zero bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("write boundary: an unrecognized permission smuggled into a hand-built Set is rejected", () => {
  assertRejectedAtWriteBoundary((tenantScope, membership) => ({
    ...grantFor(membership),
    authority: { tenantId: tenantScope.tenantId, permissions: new Set(["READ", "ADMIN"]) as never, canPerformProtectedActions: false },
  }));
});

test("write boundary: permissions that are not a Set are rejected", () => {
  assertRejectedAtWriteBoundary((tenantScope, membership) => ({
    ...grantFor(membership),
    authority: { tenantId: tenantScope.tenantId, permissions: ["READ"] as never, canPerformProtectedActions: false },
  }));
});

test("write boundary: a non-boolean canPerformProtectedActions is rejected", () => {
  assertRejectedAtWriteBoundary((tenantScope, membership) => ({
    ...grantFor(membership),
    authority: { tenantId: tenantScope.tenantId, permissions: new Set<Permission>(["READ"]), canPerformProtectedActions: "yes" as never },
  }));
});

test("write boundary: an authority from a different tenant is rejected", () => {
  assertRejectedAtWriteBoundary((_tenantScope, membership) => ({
    ...grantFor(membership),
    authority: authorityIn(createTenantScope("tenant-other")),
  }));
});

test("write boundary: an assignment bound to a different membership is rejected", () => {
  assertRejectedAtWriteBoundary((tenantScope, membership) => ({
    ...grantFor(membership),
    assignments: [
      createAssignmentReference({ assignmentId: "asg-x", membership: membershipIn(tenantScope, "mem-other", "p-other"), customerId: "cust-1" }),
    ],
  }));
});

test("write boundary: an assignment from a different tenant is rejected", () => {
  assertRejectedAtWriteBoundary((_tenantScope, membership) => ({
    ...grantFor(membership),
    assignments: [
      createAssignmentReference({ assignmentId: "asg-x", membership: membershipIn(createTenantScope("tenant-other")), customerId: "cust-1" }),
    ],
  }));
});

test("write boundary: duplicate assignment ids within one grant are rejected", () => {
  assertRejectedAtWriteBoundary((_tenantScope, membership) => {
    const assignment = createAssignmentReference({ assignmentId: "asg-dup", membership, customerId: "cust-1" });
    return { ...grantFor(membership), assignments: [assignment, assignment] };
  });
});

test("write boundary: a role context issued for a different membership is rejected", () => {
  assertRejectedAtWriteBoundary((tenantScope, membership) => ({
    ...grantFor(membership),
    roleContext: createOrganizationAccessRoleContext({ membership: membershipIn(tenantScope, "mem-other", "p-other"), role: "OWNER" }),
  }));
});

test("write boundary: an unrecognized role-context role is rejected", () => {
  assertRejectedAtWriteBoundary((_tenantScope, membership) => ({
    ...grantFor(membership),
    roleContext: { ...createOrganizationAccessRoleContext({ membership, role: "MEMBER" }), role: "SUPERUSER" as never },
  }));
});

test("write boundary: a non-canonical membershipId is rejected", () => {
  assertRejectedAtWriteBoundary((_tenantScope, membership) => ({ ...grantFor(membership), membershipId: " mem-1 " as never }));
});

test("write boundary: update also runs the shared coherence check - nothing applied", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-12");
    const store = new FileDurableStaffAccessGrantStore(dir);
    const membership = membershipIn(tenantScope);
    store.create(grantFor(membership));
    assert.throws(
      () =>
        store.update({
          tenantId: tenantScope.tenantId,
          membershipId: membership.membershipId,
          expectedVersion: 1,
          next: { ...grantFor(membership), authority: authorityIn(createTenantScope("tenant-other")) },
        }),
      InvalidStaffAccessGrantStoreError,
    );
    assert.equal(store.get(tenantScope.tenantId, membership.membershipId)?.version, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: not valid JSON fails closed", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-json");
    const store = new FileDurableStaffAccessGrantStore(dir);
    writeFileSync(tenantFilePath(dir, tenantScope.tenantId), "{ not json", "utf8");
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedStaffAccessGrantFileError);
    assert.throws(() => store.get(tenantScope.tenantId, "mem-1" as never), CorruptedStaffAccessGrantFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: top-level content must be an object, not an array", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-array");
    const store = new FileDurableStaffAccessGrantStore(dir);
    writeFileSync(tenantFilePath(dir, tenantScope.tenantId), "[]", "utf8");
    assert.throws(() => store.listByTenant(tenantScope.tenantId), CorruptedStaffAccessGrantFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: a well-formed raw record replays (control for the corruption cases below)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope("tenant-grant-control");
    const store = new FileDurableStaffAccessGrantStore(dir);
    writeFileSync(tenantFilePath(dir, tenantScope.tenantId), JSON.stringify({ "mem-1": rawRecord(tenantScope.tenantId) }), "utf8");
    const read = store.get(tenantScope.tenantId, "mem-1" as never);
    assert.deepEqual([...(read?.grant.authority.permissions ?? [])], ["READ"]);
    assert.equal(read?.grant.roleContext?.role, "ADMIN");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupted file: stored key must match the embedded membershipId", () => {
  withCorruptedRecord((_record, grant) => {
    grant["membershipId"] = "mem-other";
  }, /key-identity substitution/);
});

test("corrupted file: cross-tenant contamination (embedded tenantId does not match the tenant file)", () => {
  withCorruptedRecord((_record, grant) => {
    grant["tenantId"] = "tenant-somewhere-else";
  }, /cross-tenant record contamination/);
});

test("corrupted file: an unrecognized permission fails closed", () => {
  withCorruptedRecord((_record, grant) => {
    grant["authority"] = { permissions: ["READ", "ADMIN"], canPerformProtectedActions: false };
  }, /authority is invalid/);
});

test("corrupted file: a duplicated permission fails closed", () => {
  withCorruptedRecord((_record, grant) => {
    grant["authority"] = { permissions: ["READ", "READ"], canPerformProtectedActions: false };
  }, /duplicate/);
});

test("corrupted file: permissions that are not an array fail closed", () => {
  withCorruptedRecord((_record, grant) => {
    grant["authority"] = { permissions: {}, canPerformProtectedActions: false };
  }, /permissions must be an array/);
});

test("corrupted file: a non-boolean canPerformProtectedActions fails closed", () => {
  withCorruptedRecord((_record, grant) => {
    grant["authority"] = { permissions: ["READ"], canPerformProtectedActions: "true" };
  }, /authority is invalid/);
});

test("corrupted file: a missing authority fails closed", () => {
  withCorruptedRecord((_record, grant) => {
    delete grant["authority"];
  }, /authority must be a JSON object/);
});

test("corrupted file: an assignment bound to a different membership fails closed", () => {
  withCorruptedRecord((_record, grant) => {
    grant["assignments"] = [{ assignmentId: "asg-1", tenantId: "tenant-grant-corrupt", membershipId: "mem-2", customerId: "cust-1" }];
  }, /different membership/);
});

test("corrupted file: an assignment with a wrong-typed field fails closed", () => {
  withCorruptedRecord((_record, grant) => {
    grant["assignments"] = [{ assignmentId: 7, tenantId: "tenant-grant-corrupt", membershipId: "mem-1", customerId: "cust-1" }];
  }, /assignmentId must be a string/);
});

test("corrupted file: an unrecognized role-context role fails closed", () => {
  withCorruptedRecord((_record, grant) => {
    (grant["roleContext"] as Record<string, unknown>)["role"] = "SUPERUSER";
  }, /OrganizationAccessRole/);
});

test("corrupted file: a non-positive version fails closed", () => {
  withCorruptedRecord((record) => {
    record["version"] = 0;
  }, /version must be a positive integer/);
});
