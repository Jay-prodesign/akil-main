import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as AutomationOperatingIntegration from "../src/domain/automation-operating-integration.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUT_OPS_FILE = "src/domain/automation-operating-integration.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
];

test("AUT-OPS-001: automation-operating-integration.ts contains no secret material", () => {
  const content = readFileSync(join(REPO_ROOT, AUT_OPS_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("AUT-OPS-001: automation-operating-integration.ts imports only sibling domain modules - no filesystem/network coupling", () => {
  const content = readFileSync(join(REPO_ROOT, AUT_OPS_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type { ProjectOwnershipRef } from "./project-ownership.js";',
    'import type { OrganizationMembership } from "./organization-membership.js";',
    'import type { OwnershipAssignment, OwnerRole } from "./ownership-assignment.js";',
    'import { resolveCurrentOwner } from "./ownership-assignment.js";',
    'import type { WorkerRoutingDecision, AdmittedWorker } from "./worker-routing-policy.js";',
  ]);
});

test("AUT-OPS-001: never calls Date.now() or fetch - every timestamp/decision is caller-supplied", () => {
  const content = readFileSync(join(REPO_ROOT, AUT_OPS_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
});

test("AUT-OPS-001: composes the existing resolveCurrentOwner/ownership-assignment machinery unmodified - no second ownership or worker-routing engine", () => {
  const content = readFileSync(join(REPO_ROOT, AUT_OPS_FILE), "utf8");
  assert.doesNotMatch(content, /resolveWorkerRoute\s*\(/);
  assert.doesNotMatch(content, /createOwnershipAssignment\s*\(/);
  assert.match(content, /resolveCurrentOwner\(/);
});

test("AUT-OPS-001 (separation between human ownership and worker identity): every function accepting an accountable human takes a full OrganizationMembership/OwnershipAssignment-derived value, never a bare id positioned where a worker id is expected", () => {
  const content = readFileSync(join(REPO_ROOT, AUT_OPS_FILE), "utf8");
  // escalateAutomationActionToHuman must take a full OrganizationMembership object (escalatedTo), not a bare membershipId string.
  assert.match(content, /escalatedTo:\s*OrganizationMembership/);
  // The action's executor identity type must remain AdmittedWorker["workerId"], never OrganizationMembership["membershipId"].
  assert.match(content, /executorWorkerId:\s*AdmittedWorker\["workerId"\]/);
  assert.match(content, /accountableOwnerMembershipId:\s*OrganizationMembership\["membershipId"\]/);
});

test("AUT-OPS-001: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(AutomationOperatingIntegration).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidAutomationActionError",
    "InvalidAutomationTransitionError",
    "bindAccountableOwnerToAutomationAction",
    "escalateAutomationActionToHuman",
    "resolveSupportBurden",
    "transitionAutomationAction",
  ]);
});

test("AUT-OPS-001: package.json still declares no new runtime dependency", () => {
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
