import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as LocalExecStaffBinding from "../src/web/local-execution-staff-binding.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/web/local-execution-staff-binding.ts";

test("LOCAL-EXEC-004: does not redefine DeviceRegistration, LocalWorkerRegistration, OrganizationMembership, or AdmittedWorker - composes existing modules unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /interface\s+DeviceRegistration\b/);
  assert.doesNotMatch(content, /interface\s+LocalWorkerRegistration\b/);
  assert.doesNotMatch(content, /interface\s+OrganizationMembership\b/);
  assert.doesNotMatch(content, /interface\s+AdmittedWorker\b/);
});

test("LOCAL-EXEC-004: never accepts a raw ownerMembershipRef/requestingOwnerMembershipRef string parameter directly from the caller - always derived via requireCurrentStaffMembership", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /ownerMembershipRef:\s*unknown/);
  assert.doesNotMatch(content, /requestingOwnerMembershipRef:\s*unknown/);
  const callCount = (content.match(/requireCurrentStaffMembership\(/g) ?? []).length;
  assert.equal(callCount, 3, "expected exactly one requireCurrentStaffMembership call per exported function");
});

test("LOCAL-EXEC-004: never calls fetch, a node: builtin, or the system clock - pure composition only", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /Date\.now\(\)|new Date\(/);
});

test("LOCAL-EXEC-004: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(LocalExecStaffBinding).sort();
  assert.deepEqual(exportedKeys, [
    "createLocalWorkerRegistrationForAuthenticatedStaff",
    "registerDeviceForAuthenticatedStaff",
    "resolveEligibleLocalWorkersForAuthenticatedStaff",
  ]);
});

test("LOCAL-EXEC-004: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(
    Object.keys(packageJson.devDependencies ?? {}).sort(),
    ["@types/node", "typescript"],
  );
});
