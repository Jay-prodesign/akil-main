import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ClaudeLocalAdapter from "../src/domain/claude-local-adapter.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER_FILE = "src/domain/claude-local-adapter.ts";

const CREDENTIAL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key-field", pattern: /api[_-]?key\s*[:=]/i },
  { label: "token-field", pattern: /\btoken\s*[:=]/i },
  { label: "password-field", pattern: /password\s*[:=]/i },
  { label: "credentials-json-path", pattern: /\.credentials\.json/i },
  { label: "cookie-field", pattern: /\bcookie\b/i },
];

test("LOCAL-EXEC-006: claude-local-adapter.ts never carries a credential/token/cookie field or a local session-file path reference", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("LOCAL-EXEC-006: imports only from local-execution.js and local-execution-bridge.js - no filesystem, network, or child_process coupling; never invokes a real Claude CLI/process", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  const importSources = Array.from(content.matchAll(/from\s+["']([^"']+)["']/g)).map((m) => m[1]);
  assert.ok(importSources.length > 0, "expected at least one import");
  for (const source of importSources) {
    assert.ok(
      source === "./local-execution.js" || source === "./local-execution-bridge.js",
      `unexpected import source: ${source}`,
    );
  }
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /\bchild_process\b/);
  assert.doesNotMatch(content, /\bspawn\s*\(/);
  assert.doesNotMatch(content, /\bexec\s*\(/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
});

test("LOCAL-EXEC-006: does not redefine LocalTaskCheckpoint, LocalWorkerAdapterResult, BridgeProtocolMessageKind, or DeviceCapabilityReadiness - composes existing ports unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  assert.doesNotMatch(content, /interface\s+LocalTaskCheckpoint\b/);
  assert.doesNotMatch(content, /interface\s+LocalWorkerAdapterResult\b/);
  assert.doesNotMatch(content, /type\s+BridgeProtocolMessageKind\s*=/);
  assert.doesNotMatch(content, /type\s+DeviceCapabilityReadiness\s*=/);
});

test("LOCAL-EXEC-006: every mapped Claude event kind resolves to a bridge message kind recognized by local-execution-bridge.ts", () => {
  const kinds: Array<Parameters<typeof ClaudeLocalAdapter.mapClaudeRunEventKindToBridgeMessageKind>[0]> = [
    "TASK_STARTED",
    "AGENT_MESSAGE",
    "TOOL_PERMISSION_REQUESTED",
    "TOOL_PERMISSION_DECIDED",
    "USAGE_REPORTED",
    "TASK_COMPLETED",
    "TASK_FAILED",
    "TASK_CANCELLED",
  ];
  for (const kind of kinds) {
    assert.doesNotThrow(() => ClaudeLocalAdapter.mapClaudeRunEventKindToBridgeMessageKind(kind));
  }
});

test("LOCAL-EXEC-006 (ADR-0003): resolveClaudeRunReadiness and resolveClaudeAdapterCapabilityReadiness both check policyCheck.disposition strictly before consulting authReadiness in their own source text", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  for (const fnName of ["resolveClaudeRunReadiness", "resolveClaudeAdapterCapabilityReadiness"]) {
    const fnStart = content.indexOf(`export function ${fnName}`);
    assert.ok(fnStart >= 0, `${fnName} not found`);
    const fnBody = content.slice(fnStart);
    const policyCheckIndex = fnBody.indexOf('"POLICY_BLOCKED"');
    const authCheckIndex = fnBody.indexOf("RECOGNIZED_AUTH_READINESS_STATUSES");
    assert.ok(policyCheckIndex >= 0 && authCheckIndex >= 0, `expected both checks present in ${fnName}`);
    assert.ok(policyCheckIndex < authCheckIndex, `${fnName} must check policy before auth readiness`);
  }
});

test("LOCAL-EXEC-006: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(ClaudeLocalAdapter).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidClaudeAdapterError",
    "createClaudeCheckpointRecord",
    "createClaudeRunRequest",
    "mapClaudeRunEventKindToBridgeMessageKind",
    "resolveClaudeAdapterCapabilityReadiness",
    "resolveClaudeAdapterPolicyCheck",
    "resolveClaudeRunOutcome",
    "resolveClaudeRunReadiness",
    "resolveClaudeUsageLimitDisposition",
  ]);
});

test("LOCAL-EXEC-006: package.json still declares no new runtime dependency - no Claude Code CLI/SDK package added", () => {
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
