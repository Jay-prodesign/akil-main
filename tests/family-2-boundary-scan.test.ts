import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as StaffSessionContext from "../src/web/staff-session-context.js";
import * as StaffSessionProvider from "../src/web/staff-session-provider.js";
import * as DevFixtureStaffSessionProvider from "../src/web/dev-fixture-staff-session-provider.js";
import * as ProductionStaffSessionProvider from "../src/web/production-staff-session-provider.js";
import * as StaffRouteGuard from "../src/web/staff-route-guard.js";
import * as StaffMembershipGuard from "../src/web/staff-membership-guard.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readModule(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

test("Family 2: production-staff-session-provider.ts never imports the dev-fixture module - mirrors production-session-provider.ts's own isolation", () => {
  const content = readModule("src/web/production-staff-session-provider.ts");
  assert.doesNotMatch(content, /dev-fixture-staff-session-provider/);
});

test("Family 2: none of the six new modules import node:, fetch, or a real IdP/OAuth SDK - fully dark/mockable", () => {
  const files = [
    "src/web/staff-session-context.ts",
    "src/web/staff-session-provider.ts",
    "src/web/dev-fixture-staff-session-provider.ts",
    "src/web/production-staff-session-provider.ts",
    "src/web/staff-route-guard.ts",
    "src/web/staff-membership-guard.ts",
  ];
  for (const file of files) {
    const content = readModule(file);
    assert.doesNotMatch(content, /from ["']node:/, `${file} must not import a node: builtin`);
    assert.doesNotMatch(content, /\bfetch\s*\(/, `${file} must not call fetch`);
    assert.doesNotMatch(content, /oauth|openid|jwt|passport/i, `${file} must not reference a real IdP/OAuth library`);
  }
});

test("Family 2: staff-session-context.ts does not import or redefine the customer-facing session-context.ts types - distinct identity domains", () => {
  const content = readModule("src/web/staff-session-context.ts");
  assert.doesNotMatch(content, /from ["'].*session-context\.js["']/);
  assert.doesNotMatch(content, /interface\s+AuthenticatedPrincipal\b/);
  assert.doesNotMatch(content, /interface\s+TenantContext\b/);
});

test("Family 2: staff-membership-guard.ts composes OrganizationMembership/TenantScope by type only - never redefines or mutates them", () => {
  const content = readModule("src/web/staff-membership-guard.ts");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  for (const line of importLines) {
    assert.match(line, /^import type /, `expected a type-only import, got: ${line}`);
  }
  assert.doesNotMatch(content, /interface\s+OrganizationMembership\b/);
  assert.doesNotMatch(content, /interface\s+TenantScope\b/);
  assert.doesNotMatch(content, /createOrganizationMembership\s*\(/);
});

test("Family 2: each module exports exactly the expected surface", () => {
  assert.deepEqual(Object.keys(StaffSessionContext).sort(), [
    "InvalidStaffSessionContextError",
    "createAuthenticatedStaffPrincipal",
  ]);
  assert.deepEqual(Object.keys(StaffSessionProvider).sort(), []);
  assert.deepEqual(Object.keys(DevFixtureStaffSessionProvider).sort(), [
    "DevFixtureStaffSessionProviderInProductionError",
    "createDevFixtureStaffSessionProvider",
  ]);
  assert.deepEqual(Object.keys(ProductionStaffSessionProvider).sort(), [
    "createProductionStaffSessionProvider",
  ]);
  assert.deepEqual(Object.keys(StaffRouteGuard).sort(), [
    "StaffUnauthenticatedError",
    "requireStaffSession",
  ]);
  assert.deepEqual(Object.keys(StaffMembershipGuard).sort(), [
    "AmbiguousStaffMembershipError",
    "NoStaffMembershipError",
    "requireCurrentStaffMembership",
    "resolveCurrentStaffMembership",
  ]);
});

test("Family 2: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readModule("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(
    Object.keys(packageJson.devDependencies ?? {}).sort(),
    ["@types/node", "typescript"],
  );
});
