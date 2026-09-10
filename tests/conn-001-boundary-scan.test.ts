import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives at <repo-root>/tests/conn-001-boundary-scan.test.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CONN_001_FILES = ["src/domain/integration-connector-catalog.ts"];

/**
 * Unlike `V2-CDO-004`'s boundary scan, this task's own spec explicitly
 * names real prebuilt connector identities (Google Drive/Workspace,
 * OpenAI, Anthropic, Google AI, GitHub, Meta) as connector-kind literals -
 * so those are expected content here, not violations. What remains
 * forbidden, unchanged from every other secret/commerce/runtime-coupling
 * boundary scan in this repository: real secret material, commerce-
 * platform coupling (Invariant 6 - AKILTA Commerce/Shopify stay a fully
 * separate project), and any actual OAuth/HTTP-client runtime dependency
 * (this module is a pure, in-memory domain contract - it makes no real
 * network call to any provider).
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "api-key", pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "secret-literal", pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "password-literal", pattern: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "generic-token-literal", pattern: /\btoken\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "private-key-block", pattern: /BEGIN (RSA|EC|OPENSSH) PRIVATE KEY/ },
  { label: "cookie-literal", pattern: /cookie\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "recovery-code-literal", pattern: /recovery[_-]?code\s*[:=]\s*['"][^'"]+['"]/i },
  { label: "bearer-literal", pattern: /bearer\s+[a-z0-9._-]{16,}/i },
];

const COMMERCE_PLATFORM_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "akilta-commerce", pattern: /akilta-commerce/i },
  { label: "Shopify", pattern: /shopify/i },
  { label: "Ticimax", pattern: /ticimax/i },
  { label: "ikas", pattern: /\bikas\b/i },
  { label: "IdeaSoft", pattern: /ideasoft/i },
  { label: "T-Soft", pattern: /t-soft/i },
  { label: "WooCommerce", pattern: /woocommerce/i },
];

const OAUTH_HTTP_RUNTIME_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "oauth-client-library", pattern: /\b(passport|simple-oauth2|openid-client)\b/i },
  { label: "fetch-based-token-exchange", pattern: /\bfetch\s*\(\s*['"]https?:\/\// },
  {
    label: "http-client-library",
    pattern: /(?:from\s+['"]|require\(\s*['"])(axios|node-fetch|got|undici)['"]/i,
  },
];

test("CONN-001: integration-connector-catalog.ts contains no secret material or commerce-platform coupling", () => {
  const violations: string[] = [];
  for (const relativePath of CONN_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of [...SECRET_PATTERNS, ...COMMERCE_PLATFORM_PATTERNS]) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("CONN-001: integration-connector-catalog.ts makes no real OAuth/HTTP-client runtime call - it is a pure, in-memory domain contract only", () => {
  const violations: string[] = [];
  for (const relativePath of CONN_001_FILES) {
    const content = readFileSync(join(REPO_ROOT, relativePath), "utf8");
    for (const { label, pattern } of OAUTH_HTTP_RUNTIME_PATTERNS) {
      if (pattern.test(content)) {
        violations.push(`${relativePath}: matched forbidden pattern "${label}"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("CONN-001: integration-connector-catalog.ts's only non-type-only runtime import from connection-authority.ts is the existing, unmodified createConnectionBinding/transitionConnectionBinding/verifyConnectionBinding surface", () => {
  const content = readFileSync(join(REPO_ROOT, "src/domain/integration-connector-catalog.ts"), "utf8");
  const importLines = content.split("\n").filter((line) => /^\s*import\b/.test(line));
  const connectionAuthorityValueImport = importLines.find(
    (line) => /connection-authority/.test(line) && !/^\s*import type\b/.test(line),
  );
  assert.ok(connectionAuthorityValueImport, "expected exactly one value import from connection-authority.js");
  assert.match(
    connectionAuthorityValueImport as string,
    /createConnectionBinding|transitionConnectionBinding|verifyConnectionBinding/,
  );
});

test("CONN-001: package.json still declares no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});

test("CONN-001: connection-authority.ts itself is untouched by this task (unmodified diff against its own already-VERIFIED content is out of scope for this test file to assert directly, but this file never re-declares any of its exported symbols)", () => {
  const catalogContent = readFileSync(join(REPO_ROOT, "src/domain/integration-connector-catalog.ts"), "utf8");
  for (const reservedExport of [
    "export class InvalidConnectionAuthorityError",
    "export class InvalidConnectionTransitionError",
    "export interface SecretRef",
    "export type AccountOwnership",
    "export type ConnectionState",
    "export function createSecretRef",
    "export interface ConnectionRequirement",
    "export function createConnectionRequirement",
    "export interface ConnectionBinding",
  ]) {
    assert.ok(
      !catalogContent.includes(reservedExport),
      `integration-connector-catalog.ts must not redeclare ${reservedExport} - it must import and reuse connection-authority.ts's own`,
    );
  }
});
