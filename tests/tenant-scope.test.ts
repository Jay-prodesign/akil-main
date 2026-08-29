import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTenantScope,
  InvalidTenantScopeError,
} from "../src/domain/tenant-scope.js";

test("T1: creates a TenantScope from a valid, non-empty tenantId", () => {
  const scope = createTenantScope("tenant-acme");
  assert.equal(scope.tenantId, "tenant-acme");
});

test("T1: rejects a missing tenantId (undefined)", () => {
  assert.throws(() => createTenantScope(undefined), InvalidTenantScopeError);
});

test("T1: rejects a missing tenantId (null)", () => {
  assert.throws(() => createTenantScope(null), InvalidTenantScopeError);
});

test("T1: rejects an empty-string tenantId", () => {
  assert.throws(() => createTenantScope(""), InvalidTenantScopeError);
});

test("T1: rejects a whitespace-only tenantId", () => {
  assert.throws(() => createTenantScope("   "), InvalidTenantScopeError);
});

test("T1: rejects a non-string tenantId", () => {
  assert.throws(() => createTenantScope(12345), InvalidTenantScopeError);
});

test("T1: rejects a tenantId with leading/trailing whitespace", () => {
  assert.throws(() => createTenantScope(" tenant-acme "), InvalidTenantScopeError);
});
