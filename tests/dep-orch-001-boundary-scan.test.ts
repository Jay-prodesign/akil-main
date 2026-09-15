import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as DeploymentOrchestration from "../src/domain/deployment-orchestration.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEP_ORCH_FILE = "src/domain/deployment-orchestration.ts";

const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "connection-string-literal", pattern: /(postgres|mysql|mongodb):\/\/[^'"\s]+:[^'"\s@]+@/i },
];

const VENDOR_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "vendor-cloudflare", pattern: /cloudflare/i },
  { label: "vendor-aws", pattern: /\baws\b/i },
  { label: "vendor-route53", pattern: /route53/i },
  { label: "vendor-name-dot-com", pattern: /godaddy|namecheap/i },
];

test("DEP-ORCH-001: deployment-orchestration.ts contains no secret material, connection string, or hard-coded DNS/hosting vendor", () => {
  const content = readFileSync(join(REPO_ROOT, DEP_ORCH_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [...SECRET_PATTERNS, ...VENDOR_PATTERNS]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("DEP-ORCH-001: imports only sibling domain/runtime modules - no filesystem, network, or DNS/cloud SDK coupling", () => {
  const content = readFileSync(join(REPO_ROOT, DEP_ORCH_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { TenantScope } from "./tenant-scope.js";',
    'import type { AppConfig } from "../runtime/app-config.js";',
    'import type { SecretRef } from "./connection-authority.js";',
  ]);
});

test("DEP-ORCH-001: never calls Date.now(), fetch, or performs a live deploy/DNS mutation - every state transition is caller-evidenced", () => {
  const content = readFileSync(join(REPO_ROOT, DEP_ORCH_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
});

test("DEP-ORCH-001: no DNS proposal ever transitions to an applied/live state - only PROPOSED/WITHDRAWN exist", () => {
  const content = readFileSync(join(REPO_ROOT, DEP_ORCH_FILE), "utf8");
  assert.doesNotMatch(content, /"APPLIED"/);
  assert.doesNotMatch(content, /"LIVE"/);
  assert.match(content, /"PROPOSED"\s*\|\s*"WITHDRAWN"/);
});

test("DEP-ORCH-001: composes AppConfig/SecretRef unmodified - no second config or secret-reference type invented", () => {
  const content = readFileSync(join(REPO_ROOT, DEP_ORCH_FILE), "utf8");
  assert.doesNotMatch(content, /interface\s+AppConfig\b/);
  assert.doesNotMatch(content, /interface\s+SecretRef\b/);
  assert.match(content, /AppConfig\[/);
  assert.match(content, /SecretRef\[/);
});

test("DEP-ORCH-001: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(DeploymentOrchestration).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidCutoverTransitionError",
    "InvalidDeploymentOrchestrationError",
    "createCutoverPlan",
    "initiateRollback",
    "markMigrationsApplied",
    "markTrafficSwitched",
    "passPreflight",
    "proposeDnsChange",
    "registerDeploymentEnvironment",
    "resolveConfigDrift",
    "verifyCutoverReadback",
    "withdrawDnsChangeProposal",
  ]);
});

test("DEP-ORCH-001: package.json still declares no new runtime dependency", () => {
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
