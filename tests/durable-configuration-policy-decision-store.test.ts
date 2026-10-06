import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  computeConfigurationPolicyDecisionProjection,
  encodeConfigurationPolicyDecisionKey,
} from "../src/domain/configuration-policy-decision-projection.js";
import {
  FileDurableConfigurationPolicyDecisionStore,
  InvalidDurableConfigurationPolicyDecisionStoreError,
  CorruptedConfigurationPolicyDecisionLineError,
} from "../src/domain/durable-configuration-policy-decision-store.js";

const tenantScope = createTenantScope("tenant-os-v0-11-store");
const decisionKey = encodeConfigurationPolicyDecisionKey({ tenantId: tenantScope.tenantId });

function freshStore(): { store: FileDurableConfigurationPolicyDecisionStore; baseDir: string } {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-11-decision-store-"));
  return { store: new FileDurableConfigurationPolicyDecisionStore(baseDir), baseDir };
}

function entry(decisionId: string, sourceRef = "platform-theme-default") {
  return computeConfigurationPolicyDecisionProjection({
    identity: { tenantId: tenantScope.tenantId },
    controls: [
      { kind: "CONFIG", scope: "PLATFORM", key: "theme", sourceRef, version: "1", identity: {} },
    ],
    decisionId,
    now: "2026-10-06T00:00:00.000Z",
  });
}

test("D1: appendDecisionProjection creates a new entry and getActiveDecisionProjection returns it", () => {
  const { store } = freshStore();
  const result = store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1"));
  assert.equal(result.created, true);
  const active = store.getActiveDecisionProjection(tenantScope.tenantId, decisionKey);
  assert.deepEqual(active, result.value);
});

test("D2: a repeated append with the SAME decisionId and identical content is a safe idempotent no-op", () => {
  const { store } = freshStore();
  const first = store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1"));
  const second = store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1"));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(second.value, first.value);
});

test("D3: a repeated append with the SAME decisionId but DIFFERENT content fails closed", () => {
  const { store } = freshStore();
  store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1", "platform-theme-default"));
  assert.throws(
    () => store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1", "platform-theme-dark")),
    InvalidDurableConfigurationPolicyDecisionStoreError,
  );
});

test("D4: multiple distinct decisionIds under the same decisionKey form an ordered append log - latest wins, full history preserved", () => {
  const { store } = freshStore();
  const first = store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1", "platform-theme-default"));
  const second = store.appendDecisionProjection(tenantScope.tenantId, entry("decision-2", "platform-theme-dark"));
  const active = store.getActiveDecisionProjection(tenantScope.tenantId, decisionKey);
  assert.deepEqual(active, second.value);
  const history = store.getDecisionProjectionHistory(tenantScope.tenantId, decisionKey);
  assert.deepEqual(history, [first.value, second.value]);
});

test("D5: getDecisionProjectionById finds a superseded (non-latest) entry by its own decisionId", () => {
  const { store } = freshStore();
  const first = store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1", "platform-theme-default"));
  store.appendDecisionProjection(tenantScope.tenantId, entry("decision-2", "platform-theme-dark"));
  const found = store.getDecisionProjectionById(tenantScope.tenantId, decisionKey, "decision-1");
  assert.deepEqual(found, first.value);
});

test("D6: cold restart reconstructs the identical history and active entry from a fresh store instance pointed at the same baseDir", () => {
  const { store, baseDir } = freshStore();
  store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1", "platform-theme-default"));
  store.appendDecisionProjection(tenantScope.tenantId, entry("decision-2", "platform-theme-dark"));
  const restarted = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  assert.deepEqual(
    restarted.getDecisionProjectionHistory(tenantScope.tenantId, decisionKey),
    store.getDecisionProjectionHistory(tenantScope.tenantId, decisionKey),
  );
  assert.deepEqual(
    restarted.getActiveDecisionProjection(tenantScope.tenantId, decisionKey),
    store.getActiveDecisionProjection(tenantScope.tenantId, decisionKey),
  );
});

test("D7: appendDecisionProjection rejects an entry whose identity.tenantId does not match the given tenantId - fails closed before any write", () => {
  const { store } = freshStore();
  const foreign = entry("decision-1");
  assert.throws(
    () => store.appendDecisionProjection("a-different-tenant" as never, foreign),
    InvalidDurableConfigurationPolicyDecisionStoreError,
  );
});

test("D8: a corrupted line (cross-tenant contamination inside identity.tenantId) fails closed on replay", () => {
  const { store, baseDir } = freshStore();
  const first = store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1"));
  const tenantKey = Buffer.from(tenantScope.tenantId, "utf8").toString("base64url");
  const decisionKeyEncoded = Buffer.from(decisionKey, "utf8").toString("base64url");
  const filePath = join(baseDir, `${tenantKey}.${decisionKeyEncoded}.decision-log.jsonl`);
  const corrupted = JSON.stringify({
    ...first.value,
    identity: { ...first.value.identity, tenantId: "a-different-tenant" },
  });
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(filePath, `${corrupted}\n`, "utf8");
  const restarted = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  assert.throws(
    () => restarted.getActiveDecisionProjection(tenantScope.tenantId, decisionKey),
    CorruptedConfigurationPolicyDecisionLineError,
  );
});

test("D9: a corrupted line (cross-key contamination - decisionKey field does not match the file's own key) fails closed on replay", () => {
  const { store, baseDir } = freshStore();
  const first = store.appendDecisionProjection(tenantScope.tenantId, entry("decision-1"));
  const tenantKey = Buffer.from(tenantScope.tenantId, "utf8").toString("base64url");
  const decisionKeyEncoded = Buffer.from(decisionKey, "utf8").toString("base64url");
  const filePath = join(baseDir, `${tenantKey}.${decisionKeyEncoded}.decision-log.jsonl`);
  const corrupted = JSON.stringify({ ...first.value, decisionKey: "a-different-decision-key" });
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(filePath, `${corrupted}\n`, "utf8");
  const restarted = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  assert.throws(
    () => restarted.getActiveDecisionProjection(tenantScope.tenantId, decisionKey),
    CorruptedConfigurationPolicyDecisionLineError,
  );
});

test("D10: a corrupted ROLLBACK line missing rolledBackToDecisionId, and a COMPUTED line illegitimately carrying it, both fail closed on replay", () => {
  const { baseDir } = freshStore();
  const first = entry("decision-1");
  const tenantKey = Buffer.from(tenantScope.tenantId, "utf8").toString("base64url");
  const decisionKeyEncoded = Buffer.from(decisionKey, "utf8").toString("base64url");
  const filePath = join(baseDir, `${tenantKey}.${decisionKeyEncoded}.decision-log.jsonl`);

  mkdirSync(baseDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ ...first, entryKind: "ROLLBACK" })}\n`, "utf8");
  const missingField = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  assert.throws(
    () => missingField.getActiveDecisionProjection(tenantScope.tenantId, decisionKey),
    CorruptedConfigurationPolicyDecisionLineError,
  );

  writeFileSync(filePath, `${JSON.stringify({ ...first, rolledBackToDecisionId: "decision-0" })}\n`, "utf8");
  const illegitimateField = new FileDurableConfigurationPolicyDecisionStore(baseDir);
  assert.throws(
    () => illegitimateField.getActiveDecisionProjection(tenantScope.tenantId, decisionKey),
    CorruptedConfigurationPolicyDecisionLineError,
  );
});

test("D11: getActiveDecisionProjection/getDecisionProjectionHistory/getDecisionProjectionById all return undefined/empty for a decisionKey that was never written", () => {
  const { store } = freshStore();
  assert.equal(store.getActiveDecisionProjection(tenantScope.tenantId, decisionKey), undefined);
  assert.deepEqual(store.getDecisionProjectionHistory(tenantScope.tenantId, decisionKey), []);
  assert.equal(store.getDecisionProjectionById(tenantScope.tenantId, decisionKey, "decision-1"), undefined);
});
