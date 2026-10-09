import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as PartnerRoutingDecision from "../src/domain/partner-routing-decision.js";

// This file lives at <repo-root>/tests/v5-ptn-002-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const V5_PTN_002_FILE = "src/domain/partner-routing-decision.ts";

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

test("V5-PTN-002: partner-routing-decision.ts contains no secret material or hard-coded provider/model coupling", () => {
  const content = readFileSync(join(REPO_ROOT, V5_PTN_002_FILE), "utf8");
  const violations: string[] = [];
  for (const { label, pattern } of [...SECRET_PATTERNS, ...PROVIDER_MODEL_PATTERNS]) {
    if (pattern.test(content)) {
      violations.push(`matched forbidden pattern "${label}"`);
    }
  }
  assert.deepEqual(violations, []);
});

test("V5-PTN-002: partner-routing-decision.ts imports only sibling domain modules - no filesystem, network, or child_process coupling", () => {
  const content = readFileSync(join(REPO_ROOT, V5_PTN_002_FILE), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.deepEqual(importLines, [
    'import type { PartnerOrganization, PartnerEmployeeMembership, PartnerClientAssignment } from "./partner-organization.js";',
    'import { resolvePartnerClientAccess } from "./partner-organization.js";',
    'import { resolvePartnerCapabilityClaimStatus, type PartnerCapabilityClaim } from "./partner-capability-admission.js";',
    'import type { ProjectOwnershipRef } from "./project-ownership.js";',
  ]);
});

test("V5-PTN-002: partner-routing-decision.ts never calls Date.now() - routing is bound to the caller-supplied asOf only", () => {
  const content = readFileSync(join(REPO_ROOT, V5_PTN_002_FILE), "utf8");
  assert.doesNotMatch(content, /Date\.now\(\)/);
});

test("V5-PTN-002: resolvePartnerRoute is the only exported routing function", () => {
  const content = readFileSync(join(REPO_ROOT, V5_PTN_002_FILE), "utf8");
  const functionMatches = content.match(/^export function \w+\(/gm) ?? [];
  assert.deepEqual(functionMatches, ["export function resolvePartnerRoute("]);
});

test("V5-PTN-002: module exports exactly the expected surface - no persistence, mutation-of-record-elsewhere, or clock-reading function", () => {
  const exportedKeys = Object.keys(PartnerRoutingDecision).sort();
  assert.deepEqual(exportedKeys, ["InvalidPartnerRoutingRequestError", "resolvePartnerRoute"]);
});

test("V5-PTN-002: package.json still declares no new runtime dependency", () => {
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
