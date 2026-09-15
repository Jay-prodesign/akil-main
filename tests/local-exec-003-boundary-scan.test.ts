import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as CodexLocalAdapter from "../src/domain/codex-local-adapter.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER_FILE = "src/domain/codex-local-adapter.ts";

const CREDENTIAL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key-field", pattern: /api[_-]?key\s*[:=]/i },
  { label: "token-field", pattern: /\btoken\s*[:=]/i },
  { label: "password-field", pattern: /password\s*[:=]/i },
  { label: "auth-json-path", pattern: /auth\.json/i },
  { label: "cookie-field", pattern: /\bcookie\b/i },
];

test("LOCAL-EXEC-003: codex-local-adapter.ts never carries a credential/token/cookie field or ~/.codex/auth.json path reference", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("LOCAL-EXEC-003: imports only sibling domain modules - no filesystem, network, or child_process coupling; never invokes a real Codex CLI/process", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { DevicePolicy, LocalTaskLease, LocalTaskCheckpoint, LocalWorkerAdapterOutcome, LocalWorkerAdapterResult } from "./local-execution.js";',
    'import { isWorkspaceRootAllowed, createLocalTaskCheckpoint } from "./local-execution.js";',
    'import type { BridgeProtocolMessageKind } from "./local-execution-bridge.js";',
    'import { isRecognizedBridgeMessageKind } from "./local-execution-bridge.js";',
  ]);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /\bchild_process\b/);
  assert.doesNotMatch(content, /\bspawn\s*\(/);
  assert.doesNotMatch(content, /\bexec\s*\(/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
});

test("LOCAL-EXEC-003: does not redefine LocalTaskCheckpoint, LocalWorkerAdapterResult, or BridgeProtocolMessageKind - composes existing ports unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  assert.doesNotMatch(content, /interface\s+LocalTaskCheckpoint\b/);
  assert.doesNotMatch(content, /interface\s+LocalWorkerAdapterResult\b/);
  assert.doesNotMatch(content, /type\s+BridgeProtocolMessageKind\s*=/);
});

test("LOCAL-EXEC-003: every mapped Codex event kind resolves to a bridge message kind recognized by local-execution-bridge.ts", () => {
  const kinds: Array<Parameters<typeof CodexLocalAdapter.mapCodexRunEventKindToBridgeMessageKind>[0]> = [
    "TASK_STARTED",
    "AGENT_MESSAGE",
    "APPROVAL_REQUESTED",
    "APPROVAL_DECIDED",
    "USAGE_REPORTED",
    "TASK_COMPLETED",
    "TASK_FAILED",
    "TASK_CANCELLED",
  ];
  for (const kind of kinds) {
    assert.doesNotThrow(() => CodexLocalAdapter.mapCodexRunEventKindToBridgeMessageKind(kind));
  }
});

test("LOCAL-EXEC-003: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(CodexLocalAdapter).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidCodexAdapterError",
    "createCodexCheckpointRecord",
    "createCodexRunRequest",
    "mapCodexRunEventKindToBridgeMessageKind",
    "resolveCodexRunOutcome",
    "resolveCodexRunReadiness",
    "resolveCodexUsageLimitDisposition",
  ]);
});

test("LOCAL-EXEC-003: package.json still declares no new runtime dependency - no Codex CLI/SDK package added", () => {
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
