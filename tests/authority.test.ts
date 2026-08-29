import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createAuthorityContext,
  requireSameTenant,
  requirePermission,
  requireProtectedActionAuthorization,
  InvalidAuthorityContextError,
  CrossTenantAuthorityError,
  InsufficientAuthorityError,
  ProtectedActionNotAuthorizedError,
} from "../src/domain/authority.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");

test("creates an AuthorityContext with valid permissions", () => {
  const authority = createAuthorityContext({
    tenantScope: tenantA,
    permissions: ["READ", "WRITE"],
    canPerformProtectedActions: false,
  });
  assert.equal(authority.tenantId, "tenant-a");
  assert.equal(authority.permissions.has("READ"), true);
  assert.equal(authority.permissions.has("WRITE"), true);
  assert.equal(authority.permissions.has("EXECUTE"), false);
  assert.equal(authority.canPerformProtectedActions, false);
});

test("rejects an invalid permission value", () => {
  assert.throws(
    () =>
      createAuthorityContext({
        tenantScope: tenantA,
        permissions: ["READ", "ADMIN"],
        canPerformProtectedActions: false,
      }),
    InvalidAuthorityContextError,
  );
});

test("rejects a non-boolean canPerformProtectedActions", () => {
  assert.throws(
    () =>
      createAuthorityContext({
        tenantScope: tenantA,
        permissions: ["READ"],
        canPerformProtectedActions: "true",
      }),
    InvalidAuthorityContextError,
  );
});

test("requirePermission passes when the permission is granted", () => {
  const authority = createAuthorityContext({
    tenantScope: tenantA,
    permissions: ["WRITE"],
    canPerformProtectedActions: false,
  });
  assert.doesNotThrow(() => requirePermission(authority, "WRITE"));
});

test("T8: requirePermission throws when the permission is not granted", () => {
  const readOnly = createAuthorityContext({
    tenantScope: tenantA,
    permissions: ["READ"],
    canPerformProtectedActions: false,
  });
  assert.throws(() => requirePermission(readOnly, "WRITE"), InsufficientAuthorityError);
  assert.throws(() => requirePermission(readOnly, "EXECUTE"), InsufficientAuthorityError);
});

test("T9: requireProtectedActionAuthorization throws when not authorized", () => {
  const authority = createAuthorityContext({
    tenantScope: tenantA,
    permissions: ["EXECUTE"],
    canPerformProtectedActions: false,
  });
  assert.throws(
    () => requireProtectedActionAuthorization(authority, "someAction"),
    ProtectedActionNotAuthorizedError,
  );
});

test("requireProtectedActionAuthorization passes when authorized", () => {
  const authority = createAuthorityContext({
    tenantScope: tenantA,
    permissions: ["EXECUTE"],
    canPerformProtectedActions: true,
  });
  assert.doesNotThrow(() =>
    requireProtectedActionAuthorization(authority, "someAction"),
  );
});

test("T2 / EI-4: requireSameTenant passes when the tenant matches", () => {
  const authority = createAuthorityContext({
    tenantScope: tenantA,
    permissions: ["READ"],
    canPerformProtectedActions: false,
  });
  assert.doesNotThrow(() => requireSameTenant(authority, tenantA.tenantId));
});

test("T2 / EI-4: requireSameTenant throws on a tenant mismatch, regardless of permissions", () => {
  const fullAuthorityForTenantA = createAuthorityContext({
    tenantScope: tenantA,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true,
  });
  assert.throws(
    () => requireSameTenant(fullAuthorityForTenantA, tenantB.tenantId),
    CrossTenantAuthorityError,
  );
});
