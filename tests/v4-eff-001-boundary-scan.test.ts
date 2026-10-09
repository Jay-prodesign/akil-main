import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ExternalEffectEnvelope from "../src/domain/external-effect-envelope.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V4_EFF_001_FILE = "src/domain/external-effect-envelope.ts";

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
];

test("V4-EFF-001: external-effect-envelope.ts contains no secret material or hard-coded provider/model coupling", () => {
  const content = readFileSync(join(REPO_ROOT, V4_EFF_001_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("V4-EFF-001: external-effect-envelope.ts imports only sibling domain modules - no filesystem, network, or child_process coupling", () => {
  const content = readFileSync(join(REPO_ROOT, V4_EFF_001_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import { requireSameTenant, requireProtectedActionAuthorization, type AuthorityContext } from "./authority.js";',
  ]);
});

test("V4-EFF-001: never calls Date.now() - every timestamp/evidence field is caller-supplied", () => {
  const content = readFileSync(join(REPO_ROOT, V4_EFF_001_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
});

test("V4-EFF-001: never performs a real network/provider call - no fetch/http/https import or usage", () => {
  const content = readFileSync(join(REPO_ROOT, V4_EFF_001_FILE), "utf8");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /require\(["']https?["']\)/);
  assert.doesNotMatch(content, /from ["']node:https?["']/);
});

test("V4-EFF-001: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(ExternalEffectEnvelope).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidExternalEffectError",
    "InvalidExternalEffectRecoveryError",
    "createExternalEffectIntent",
    "isRecognizedExternalEffectAttemptState",
    "reportExternalEffectOutcome",
    "retryExternalEffectAttempt",
    "rollbackExternalEffectAttempt",
    "startExternalEffectAttempt",
    "verifyExternalEffectReadback",
  ]);
});

test("V4-EFF-001: package.json still declares no new runtime dependency", () => {
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
