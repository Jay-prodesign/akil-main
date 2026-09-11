import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as LocalExecution from "../src/domain/local-execution.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCAL_EXEC_001_FILE = "src/domain/local-execution.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
  { label: "oauth-refresh-token-field", pattern: /oauthRefreshToken|sessionCookie|rawApiKey/i },
];

const PROVIDER_MODEL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "openai-sdk-import", pattern: /require\(["']@?openai/i },
  { label: "anthropic-sdk-import", pattern: /require\(["']@?anthropic/i },
];

test("LOCAL-EXEC-001: local-execution.ts contains no secret material, credential field, or real provider SDK import", () => {
  const content = readFileSync(join(REPO_ROOT, LOCAL_EXEC_001_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("LOCAL-EXEC-001: local-execution.ts imports only sibling domain modules - no filesystem, network, or child_process coupling", () => {
  const content = readFileSync(join(REPO_ROOT, LOCAL_EXEC_001_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type { ProjectOwnershipRef } from "./project-ownership.js";',
    "import type {",
  ]);
});

test("LOCAL-EXEC-001: never calls Date.now(), fetch, or opens a real network/process handle - pure domain contracts only", () => {
  const content = readFileSync(join(REPO_ROOT, LOCAL_EXEC_001_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /child_process/);
  assert.doesNotMatch(content, /WebSocket/);
  assert.doesNotMatch(content, /from ["']node:/);
});

test("LOCAL-EXEC-001: no LocalWorkerRouter is defined - this module composes with the existing worker-routing-policy.ts only", () => {
  const content = readFileSync(join(REPO_ROOT, LOCAL_EXEC_001_FILE), "utf8");
  assert.doesNotMatch(content, /LocalWorkerRouter/);
  assert.doesNotMatch(content, /resolveLocalRoute/);
});

test("LOCAL-EXEC-001: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(LocalExecution).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidDeviceTransitionError",
    "InvalidLocalExecutionError",
    "InvalidLocalTaskLeaseTransitionError",
    "createDeviceCapabilitySnapshot",
    "createDevicePolicy",
    "createExecutionPolicy",
    "createLocalTaskCheckpoint",
    "createLocalTaskLease",
    "createLocalWorkerRegistration",
    "engageKillSwitch",
    "isWorkspaceRootAllowed",
    "markDeviceOffline",
    "markDeviceOnline",
    "quarantineDevice",
    "registerDevice",
    "resolveEligibleLocalWorkers",
    "revokeDevice",
    "toAdmittedWorker",
    "transitionLocalTaskLease",
  ]);
});

test("LOCAL-EXEC-001: package.json still declares no new runtime dependency", () => {
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
