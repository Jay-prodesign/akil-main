import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as LocalExecutionBridge from "../src/domain/local-execution-bridge.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCAL_EXEC_002_FILE = "src/domain/local-execution-bridge.ts";

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

test("LOCAL-EXEC-002: local-execution-bridge.ts contains no secret material, credential field, or real provider SDK import", () => {
  const content = readFileSync(join(REPO_ROOT, LOCAL_EXEC_002_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("LOCAL-EXEC-002: local-execution-bridge.ts imports only sibling domain modules - no filesystem, network, or crypto coupling", () => {
  const content = readFileSync(join(REPO_ROOT, LOCAL_EXEC_002_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type { DeviceRegistration, DevicePolicy, LocalTaskLease, LocalTaskCheckpoint } from "./local-execution.js";',
    'import { markDeviceOnline, isWorkspaceRootAllowed } from "./local-execution.js";',
  ]);
});

test("LOCAL-EXEC-002: never calls Date.now(), opens a real socket, spawns a process, or references a real crypto library - pure protocol/domain contracts only", () => {
  const content = readFileSync(join(REPO_ROOT, LOCAL_EXEC_002_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /child_process/);
  assert.doesNotMatch(content, /\bWebSocket\b/);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /require\(["']ws["']\)/);
  assert.doesNotMatch(content, /\bcrypto\b/i);
});

test("LOCAL-EXEC-002: no second worker router or device-status graph is invented - composes local-execution.ts's own markDeviceOnline/isWorkspaceRootAllowed unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, LOCAL_EXEC_002_FILE), "utf8");
  assert.doesNotMatch(content, /LocalWorkerRouter/);
  assert.doesNotMatch(content, /resolveLocalRoute/);
  assert.match(content, /markDeviceOnline\(/);
  assert.match(content, /isWorkspaceRootAllowed\(/);
});

test("LOCAL-EXEC-002: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(LocalExecutionBridge).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidBridgeConnectionTransitionError",
    "InvalidBridgeEnrollmentError",
    "InvalidBridgeProtocolError",
    "InvalidBridgeReplayError",
    "SUPPORTED_BRIDGE_PROTOCOL_VERSIONS",
    "completeDeviceEnrollment",
    "createEnrollmentChallenge",
    "isRecognizedBridgeMessageKind",
    "processBridgeHeartbeat",
    "resolveAllowedWorkspacePath",
    "transitionBridgeConnectionState",
    "validateBridgeMessageReplay",
    "validateBridgeProtocolEnvelope",
    "validateCheckpointMessageEnvelope",
    "validateLeaseMessageEnvelope",
  ]);
});

test("LOCAL-EXEC-002: package.json still declares no new runtime dependency", () => {
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
