import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as WebsiteBuildControlAdapter from "../src/domain/website-build-control-adapter.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ADAPTER_FILE = "src/domain/website-build-control-adapter.ts";

test("Family 5: website-build-control-adapter.ts never calls fetch, a node: builtin, or performs a live network/DNS call itself - every write goes through the injected connector transport", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  assert.doesNotMatch(content, /\bfetch\s*\(/);
  assert.doesNotMatch(content, /from ["']node:/);
  assert.doesNotMatch(content, /Date\.now\(\)/);
});

test("Family 5: does not redefine ExecutionMaturity, ConnectorExecutionResult, ExternalEffectIntent, or ExternalEffectAttempt - composes CONN-001/V4-EFF-001 unmodified", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  assert.doesNotMatch(content, /type\s+ExecutionMaturity\s*=/);
  assert.doesNotMatch(content, /interface\s+ConnectorExecutionResult\b/);
  assert.doesNotMatch(content, /interface\s+ExternalEffectIntent\b/);
  assert.doesNotMatch(content, /interface\s+ExternalEffectAttempt\b/);
});

test("Family 5: never calls executeConnectorCapability outside readWebsiteBuildSignal/controlledApplyWebsiteBuildEffect - no hidden third write path", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  const callSites = content.match(/executeConnectorCapability\(/g) ?? [];
  // one import reference + exactly two call sites
  assert.equal(callSites.length, 2);
});

test("Family 5: DRAFT_PREVIEW intents always require approval - requiresApproval is never a caller-settable field", () => {
  const content = readFileSync(join(REPO_ROOT, ADAPTER_FILE), "utf8");
  assert.match(content, /requiresApproval:\s*true/);
  assert.doesNotMatch(content, /requiresApproval:\s*input\./);
});

test("Family 5: module exports exactly the expected surface", () => {
  const exportedKeys = Object.keys(WebsiteBuildControlAdapter).sort();
  assert.deepEqual(exportedKeys, [
    "InvalidWebsiteBuildControlAdapterError",
    "controlledApplyWebsiteBuildEffect",
    "diagnoseWebsiteBuildSignal",
    "draftWebsiteBuildEffectIntent",
    "readWebsiteBuildSignal",
    "recommendWebsiteBuildAction",
    "startWebsiteBuildEffectAttempt",
  ]);
});

test("Family 5: package.json still declares no new runtime dependency", () => {
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
