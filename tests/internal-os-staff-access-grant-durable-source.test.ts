import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createAuthorityContext, type Permission } from "../src/domain/authority.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import {
  createAssignmentReference,
  createOrganizationMembership,
  type OrganizationMembership,
} from "../src/domain/organization-membership.js";
import { createOrganizationAccessRoleContext } from "../src/domain/organization-access-role.js";
import { FileDurableOrganizationMembershipStore, CorruptedOrganizationMembershipFileError } from "../src/domain/durable-organization-membership-store.js";
import {
  FileDurableStaffAccessGrantStore,
  CorruptedStaffAccessGrantFileError,
  type StaffAccessGrantRecord,
} from "../src/domain/durable-staff-access-grant-store.js";
import {
  createCurrentStaffAccessGrantsInternalOsRequestHandler,
  createDurableInternalOsStaffAccessGrantSource,
  type InternalOsStaffAccessGrantSource,
} from "../src/web/internal-os-staff-access-grant-durable-source.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { STAFF_SESSION_TOKEN_HEADER } from "../src/web/internal-os-request-handler.js";

/**
 * C2: unit tests for `createDurableInternalOsStaffAccessGrantSource` (the
 * grant-store x membership-store join) and
 * `createCurrentStaffAccessGrantsInternalOsRequestHandler` (the per-request
 * wrapper), without an HTTP server. `runtime-staff-access-grants.test.ts`
 * covers the same behavior through the composed runtime.
 */

const TENANT = "tenant-c2-source";
const tenantScope = createTenantScope(TENANT);

function freshDirs(): { root: string; grants: FileDurableStaffAccessGrantStore; memberships: FileDurableOrganizationMembershipStore } {
  const root = mkdtempSync(join(tmpdir(), "c2-grant-source-"));
  return {
    root,
    grants: new FileDurableStaffAccessGrantStore(join(root, "grants")),
    memberships: new FileDurableOrganizationMembershipStore(join(root, "memberships")),
  };
}

function membership(membershipId: string, principalRef: string): OrganizationMembership {
  return createOrganizationMembership({ membershipId, tenantScope, principalRef, role: "STAFF" });
}

function record(forMembership: OrganizationMembership, permissions: ReadonlyArray<Permission>): StaffAccessGrantRecord {
  return {
    tenantId: forMembership.tenantId,
    membershipId: forMembership.membershipId,
    authority: createAuthorityContext({ tenantScope, permissions, canPerformProtectedActions: false }),
    assignments: [],
  };
}

test("only memberships with an explicit grant record appear - the others are absent, not defaulted", () => {
  const { root, grants, memberships } = freshDirs();
  try {
    const granted = membership("mem-granted", "principal-granted");
    memberships.create(granted);
    memberships.create(membership("mem-ungranted", "principal-ungranted"));
    grants.create(record(granted, ["READ"]));

    const result = createDurableInternalOsStaffAccessGrantSource(grants, memberships, { tenantId: TENANT }).listCurrentGrants();
    assert.equal(result.length, 1);
    assert.equal(result[0]?.membership.membershipId, "mem-granted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authority, assignments and role context are passed through exactly as stored - no permission derived from any role", () => {
  const { root, grants, memberships } = freshDirs();
  try {
    const owner = membership("mem-owner", "principal-owner");
    memberships.create(owner);
    const stored: StaffAccessGrantRecord = {
      ...record(owner, []),
      assignments: [createAssignmentReference({ assignmentId: "asg-1", membership: owner, customerId: "cust-1", projectId: "proj-1" })],
      roleContext: createOrganizationAccessRoleContext({ membership: owner, role: "OWNER" }),
    };
    grants.create(stored);

    const [grant] = createDurableInternalOsStaffAccessGrantSource(grants, memberships, { tenantId: TENANT }).listCurrentGrants();
    assert.ok(grant !== undefined);
    assert.deepEqual(grant.membership, owner);
    assert.equal(grant.authority.permissions.size, 0, "an OWNER role context must not imply any permission");
    assert.equal(grant.authority.canPerformProtectedActions, false);
    assert.deepEqual(grant.assignments, stored.assignments);
    assert.deepEqual(grant.roleContext, stored.roleContext);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a grant record with no matching membership record is absent", () => {
  const { root, grants, memberships } = freshDirs();
  try {
    grants.create(record(membership("mem-orphan", "principal-orphan"), ["READ", "WRITE"]));
    assert.deepEqual(createDurableInternalOsStaffAccessGrantSource(grants, memberships, { tenantId: TENANT }).listCurrentGrants(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a REVOKED membership is passed through as currently stored - the existing access gate, not this adapter, refuses it", () => {
  const { root, grants, memberships } = freshDirs();
  try {
    const revokedLater = membership("mem-revoked", "principal-revoked");
    memberships.create(revokedLater);
    grants.create(record(revokedLater, ["READ"]));
    memberships.revoke({
      tenantId: tenantScope.tenantId,
      membershipId: revokedLater.membershipId,
      expectedVersion: 1,
      revokedAt: "2026-10-23T00:00:00.000Z",
      revokedReason: "left",
    });
    const [grant] = createDurableInternalOsStaffAccessGrantSource(grants, memberships, { tenantId: TENANT }).listCurrentGrants();
    assert.equal(grant?.membership.state, "REVOKED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("other tenants' grants and memberships are never read into this tenant's grants", () => {
  const { root, grants, memberships } = freshDirs();
  try {
    const otherScope = createTenantScope("tenant-c2-other");
    const foreign = createOrganizationMembership({ membershipId: "mem-x", tenantScope: otherScope, principalRef: "p-x", role: "STAFF" });
    memberships.create(foreign);
    grants.create({
      tenantId: otherScope.tenantId,
      membershipId: foreign.membershipId,
      authority: createAuthorityContext({ tenantScope: otherScope, permissions: ["READ"], canPerformProtectedActions: false }),
      assignments: [],
    });
    assert.deepEqual(createDurableInternalOsStaffAccessGrantSource(grants, memberships, { tenantId: TENANT }).listCurrentGrants(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupted grant file throws CorruptedStaffAccessGrantFileError - it is never relabeled as an empty grant list", () => {
  const { root, grants, memberships } = freshDirs();
  try {
    const safeKey = Buffer.from(TENANT, "utf8").toString("base64url");
    writeFileSync(join(root, "grants", `${safeKey}.json`), "{ corrupted", "utf8");
    const source = createDurableInternalOsStaffAccessGrantSource(grants, memberships, { tenantId: TENANT });
    assert.throws(() => source.listCurrentGrants(), CorruptedStaffAccessGrantFileError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupted membership file throws even when no grant record exists", () => {
  const { root, grants, memberships } = freshDirs();
  try {
    const safeKey = Buffer.from(TENANT, "utf8").toString("base64url");
    writeFileSync(join(root, "memberships", `${safeKey}.json`), "[]", "utf8");
    const source = createDurableInternalOsStaffAccessGrantSource(grants, memberships, { tenantId: TENANT });
    assert.throws(() => source.listCurrentGrants(), CorruptedOrganizationMembershipFileError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed configured tenantId fails at construction", () => {
  const { root, grants, memberships } = freshDirs();
  try {
    assert.throws(() => createDurableInternalOsStaffAccessGrantSource(grants, memberships, { tenantId: " padded " }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const organization = activateOrganization({
  organization: createOrganization({ organizationId: "org-c2", tenantScope, displayName: "C2 Org", createdAt: "2026-10-23T00:00:00.000Z" }),
  activatedAt: "2026-10-23T00:00:00.000Z",
});
const provider = createDevFixtureStaffSessionProvider({
  fixtures: new Map([
    [
      "tok",
      { principal: createAuthenticatedStaffPrincipal({ principalId: "principal-granted", displayName: "Granted" }), issuedAt: "2026-10-23T00:00:00.000Z" },
    ],
  ]),
  isProduction: false,
});

function handlerWith(grantSource: InternalOsStaffAccessGrantSource) {
  return createCurrentStaffAccessGrantsInternalOsRequestHandler({
    provider,
    organizationSource: { getCurrentOrganization: () => organization },
    grantSource,
  });
}

test("handler: a throwing grant source renders the OS ERROR page (500), never FORBIDDEN", () => {
  const response = handlerWith({
    listCurrentGrants: () => {
      throw new Error("disk exploded");
    },
  })({ method: "GET", path: "/os/home", headers: { [STAFF_SESSION_TOKEN_HEADER]: "tok" } });
  assert.equal(response.status, 500);
  assert.match(response.body, /Something went wrong/);
  assert.doesNotMatch(response.body, /disk exploded/);
});

test("handler: grants are read on every request, and the inner access gate decides with exactly those grants", () => {
  const granted = membership("mem-granted", "principal-granted");
  let current: ReturnType<InternalOsStaffAccessGrantSource["listCurrentGrants"]> = [];
  let reads = 0;
  const handler = handlerWith({
    listCurrentGrants: () => {
      reads += 1;
      return current;
    },
  });
  const request = { method: "GET", path: "/os/home", headers: { [STAFF_SESSION_TOKEN_HEADER]: "tok" } };
  assert.equal(handler(request).status, 403);
  current = [{ membership: granted, authority: createAuthorityContext({ tenantScope, permissions: ["READ"], canPerformProtectedActions: false }), assignments: [] }];
  assert.equal(handler(request).status, 200);
  assert.equal(reads, 2);
});
