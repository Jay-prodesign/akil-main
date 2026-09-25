import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createOrganizationMembership,
  revokeOrganizationMembership,
  type OrganizationMembership,
} from "../src/domain/organization-membership.js";
import {
  createOrganizationAccessRoleContext,
  isValidOrganizationAccessRole,
  InvalidOrganizationAccessRoleContextError,
  type OrganizationAccessRoleContext,
} from "../src/domain/organization-access-role.js";

const tenantScope = createTenantScope("tenant-os-v0-02-role");

function buildMembership(overrides: {
  membershipId?: string;
  principalRef?: string;
  role?: "STAFF" | "JUNIOR" | "STUDENT" | "CLIENT_ASSOCIATE";
} = {}): OrganizationMembership {
  return createOrganizationMembership({
    membershipId: overrides.membershipId ?? "membership-role-1",
    tenantScope,
    principalRef: overrides.principalRef ?? "principal-role-1",
    role: overrides.role ?? "STAFF",
  });
}

// ---------------------------------------------------------------------------
// D1: factory constructs OWNER/ADMIN/MEMBER deterministically
// ---------------------------------------------------------------------------

test("D1: factory constructs OWNER, ADMIN and MEMBER role contexts deterministically, inheriting exact tenantId/membershipId/principalRef from an ACTIVE membership", () => {
  const membership = buildMembership();
  for (const role of ["OWNER", "ADMIN", "MEMBER"] as const) {
    const a = createOrganizationAccessRoleContext({ membership, role });
    const b = createOrganizationAccessRoleContext({ membership, role });
    assert.deepEqual(a, b);
    assert.equal(a.role, role);
    assert.equal(a.tenantId, membership.tenantId);
    assert.equal(a.membershipId, membership.membershipId);
    assert.equal(a.principalRef, membership.principalRef);
  }
});

// ---------------------------------------------------------------------------
// D2: invalid/legacy/unknown curated role values reject
// ---------------------------------------------------------------------------

test("D2: an invalid/unknown curated role value rejects", () => {
  const membership = buildMembership();
  assert.throws(
    () => createOrganizationAccessRoleContext({ membership, role: "SUPERADMIN" }),
    InvalidOrganizationAccessRoleContextError,
  );
  assert.throws(
    () => createOrganizationAccessRoleContext({ membership, role: "" }),
    InvalidOrganizationAccessRoleContextError,
  );
  assert.throws(
    () => createOrganizationAccessRoleContext({ membership, role: undefined }),
    InvalidOrganizationAccessRoleContextError,
  );
});

test("D2: legacy OrganizationMembership.role values (STAFF/JUNIOR/STUDENT/CLIENT_ASSOCIATE) are never accepted as curated access roles", () => {
  const membership = buildMembership();
  for (const legacyRole of ["STAFF", "JUNIOR", "STUDENT", "CLIENT_ASSOCIATE"]) {
    assert.throws(
      () => createOrganizationAccessRoleContext({ membership, role: legacyRole }),
      InvalidOrganizationAccessRoleContextError,
    );
    assert.equal(isValidOrganizationAccessRole(legacyRole), false);
  }
});

// ---------------------------------------------------------------------------
// D3: factory rejects REVOKED and incoherent ACTIVE membership records
// ---------------------------------------------------------------------------

test("D3: the factory rejects a REVOKED membership - a revoked member can never be minted a curated role", () => {
  const revoked = revokeOrganizationMembership({
    membership: buildMembership(),
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "offboarded",
  });
  assert.throws(
    () => createOrganizationAccessRoleContext({ membership: revoked, role: "OWNER" }),
    InvalidOrganizationAccessRoleContextError,
  );
});

test("D3 (adversarial): the factory rejects a hand-built incoherent 'ACTIVE' membership already carrying revocation metadata", () => {
  const membership = buildMembership();
  const forged = {
    ...membership,
    state: "ACTIVE",
    revokedAt: "2026-01-01T00:00:00.000Z",
    revokedReason: "stale",
  } as unknown as OrganizationMembership;
  assert.throws(
    () => createOrganizationAccessRoleContext({ membership: forged, role: "ADMIN" }),
    InvalidOrganizationAccessRoleContextError,
  );
});

// ---------------------------------------------------------------------------
// D15: boundary/dependency scan
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROLE_SOURCE_PATH = "src/domain/organization-access-role.ts";

test("D15/boundary: organization-access-role.ts contains no session/provider/store/network/persistence/AI-Commerce dependency, no Date.now/randomness, and no mutable singleton/global registry", () => {
  const content = readFileSync(join(REPO_ROOT, ROLE_SOURCE_PATH), "utf8");
  const forbidden: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    { label: "persistence/store", pattern: /\b(fs\.|node:fs|readFile|writeFile|Database|Repository)\b/ },
    { label: "network/HTTP/fetch", pattern: /\b(fetch\(|node:http|node:https|XMLHttpRequest)\b/ },
    { label: "provider/secret/credential", pattern: /\b(secret|credential|apiKey|password|token)\b/i },
    { label: "session/identity provider", pattern: /\bSessionContext\b/ },
    { label: "Shopify/AI Commerce coupling", pattern: /\b(shopify|ai[-_]?commerce)\b/i },
    { label: "Date.now/randomness", pattern: /\b(Date\.now\(\)|Math\.random\(\)|new Date\(\))\b/ },
    { label: "mutable singleton/global registry", pattern: /\b(globalThis\.|global\.|let\s+\w+\s*:\s*Map)\b/ },
  ];
  for (const { label, pattern } of forbidden) {
    assert.equal(pattern.test(content), false, `found forbidden pattern "${label}" in ${ROLE_SOURCE_PATH}`);
  }
});

test("D15/boundary: organization-access-role.ts imports only organization-membership.ts and tenant-scope.ts - no ownership-assignment.ts/project.ts/authority.ts import", () => {
  const content = readFileSync(join(REPO_ROOT, ROLE_SOURCE_PATH), "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(importedModules.length > 0, "expected at least one import statement");
  const allowedModules = ["organization-membership.js", "tenant-scope.js"];
  for (const specifier of importedModules) {
    assert.ok(
      allowedModules.some((mod) => specifier?.includes(mod)),
      `unexpected import specifier: ${specifier}`,
    );
  }
  for (const forbidden of ["ownership-assignment.js", "project.js", "authority.js", "organization.js"]) {
    assert.equal(content.includes(forbidden), false, `must not import "${forbidden}"`);
  }
});

// Type-only reference so `OrganizationAccessRoleContext` stays exercised by
// the type checker even though no test asserts on its full shape directly.
const _typeCheck: OrganizationAccessRoleContext["role"] = "MEMBER";
void _typeCheck;
