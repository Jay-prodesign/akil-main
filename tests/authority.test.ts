import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAuthorityContext,
  requirePermission,
  requireProtectedActionAuthorization,
  InvalidAuthorityContextError,
  InsufficientAuthorityError,
  ProtectedActionNotAuthorizedError,
} from "../src/domain/authority.js";

test("creates an AuthorityContext with valid permissions", () => {
  const authority = createAuthorityContext({
    permissions: ["READ", "WRITE"],
    canPerformProtectedActions: false,
  });
  assert.equal(authority.permissions.has("READ"), true);
  assert.equal(authority.permissions.has("WRITE"), true);
  assert.equal(authority.permissions.has("EXECUTE"), false);
  assert.equal(authority.canPerformProtectedActions, false);
});

test("rejects an invalid permission value", () => {
  assert.throws(
    () =>
      createAuthorityContext({
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
        permissions: ["READ"],
        canPerformProtectedActions: "true",
      }),
    InvalidAuthorityContextError,
  );
});

test("requirePermission passes when the permission is granted", () => {
  const authority = createAuthorityContext({
    permissions: ["WRITE"],
    canPerformProtectedActions: false,
  });
  assert.doesNotThrow(() => requirePermission(authority, "WRITE"));
});

test("T8: requirePermission throws when the permission is not granted", () => {
  const readOnly = createAuthorityContext({
    permissions: ["READ"],
    canPerformProtectedActions: false,
  });
  assert.throws(() => requirePermission(readOnly, "WRITE"), InsufficientAuthorityError);
  assert.throws(() => requirePermission(readOnly, "EXECUTE"), InsufficientAuthorityError);
});

test("T9: requireProtectedActionAuthorization throws when not authorized", () => {
  const authority = createAuthorityContext({
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
    permissions: ["EXECUTE"],
    canPerformProtectedActions: true,
  });
  assert.doesNotThrow(() =>
    requireProtectedActionAuthorization(authority, "someAction"),
  );
});
