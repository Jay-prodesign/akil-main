import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as InternalCommandAccess from "../src/web/internal-command-access.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODULE_FILE = "src/web/internal-command-access.ts";

test("Family 10: never imports the customer-facing session-context.ts/session-provider.ts/route-guard.ts - internal command access cannot be reached through a customer session", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /from ["']\.\/session-context\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/session-provider\.js["']/);
  assert.doesNotMatch(content, /from ["']\.\/route-guard\.js["']/);
});

test("Family 10: does not redefine StaffSessionContext, OrganizationMembership, or InternalCommandCenterProjection - composes existing modules unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /interface\s+StaffSessionContext\b/);
  assert.doesNotMatch(content, /interface\s+OrganizationMembership\b/);
  assert.doesNotMatch(content, /interface\s+InternalCommandCenterProjection\b/);
});

test("Family 10: resolveInternalCommandCenterView always gates through requireInternalCommandAccess before calling buildInternalCommandCenterProjection", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  const fnStart = content.indexOf("export function resolveInternalCommandCenterView");
  assert.ok(fnStart >= 0, "resolveInternalCommandCenterView not found");
  const fnBody = content.slice(fnStart);
  const accessCallIndex = fnBody.indexOf("requireInternalCommandAccess(");
  const projectionCallIndex = fnBody.indexOf("buildInternalCommandCenterProjection(");
  assert.ok(accessCallIndex >= 0 && projectionCallIndex >= 0, "expected both calls present");
  assert.ok(accessCallIndex < projectionCallIndex, "access must be checked before the projection is built");
});

test("Family 10: never calls fetch, a node: builtin, or the system clock - pure composition only", () => {
  const content = readFileSync(join(REPO_ROOT, MODULE_FILE), "utf8");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /Date\.now\(\)|new Date\(/);
});

test("Family 10: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(InternalCommandAccess).sort();
  assert.deepEqual(exportedKeys, [
    "requireInternalCommandAccess",
    "resolveInternalCommandCenterView",
  ]);
});

test("Family 10: package.json still declares no new runtime dependency", () => {
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
