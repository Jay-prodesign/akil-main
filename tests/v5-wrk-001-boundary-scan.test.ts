import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as WorkerRoutingPolicy from "../src/domain/worker-routing-policy.js";

// This file lives at <repo-root>/tests/v5-wrk-001-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V5_WRK_001_FILE = "src/domain/worker-routing-policy.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
];

const PROVIDER_MODEL_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "openai", pattern: /openai/i },
  { label: "anthropic", pattern: /anthropic/i },
  { label: "shopify", pattern: /shopify/i },
  { label: "oauth", pattern: /oauth/i },
  { label: "claude", pattern: /claude/i },
  { label: "codex", pattern: /codex/i },
];

test("V5-WRK-001: worker-routing-policy.ts contains no secret material and no hard-coded provider/model/worker-identity coupling", () => {
  const content = readFileSync(join(REPO_ROOT, V5_WRK_001_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("V5-WRK-001: worker-routing-policy.ts has zero imports - no filesystem, network, child_process, or sibling-domain coupling", () => {
  const content = readFileSync(join(REPO_ROOT, V5_WRK_001_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, []);
});

test("V5-WRK-001: worker-routing-policy.ts never calls Date.now() - it is a pure, stateless decision function over caller-supplied input only", () => {
  const content = readFileSync(join(REPO_ROOT, V5_WRK_001_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
});

test("V5-WRK-001: module exports exactly the expected routing-decision surface - no invocation, persistence, or provider-call function", () => {
  const exportedKeys = Object.keys(WorkerRoutingPolicy).sort();
  assert.deepEqual(exportedKeys, ["InvalidWorkerRoutingRequestError", "resolveWorkerRoute"]);
});

test("V5-WRK-001: package.json still declares no new runtime dependency", () => {
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
