import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { FileDurableEvidenceReferenceStore } from "../src/domain/durable-evidence-reference-store.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "evidence-reference-store-lock-"));
}

function plantLock(dir: string, tenantId: string, ageMs: number): void {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  const lockPath = join(dir, ".locks", `${safeKey}.lock`);
  mkdirSync(join(dir, ".locks"), { recursive: true });
  writeFileSync(lockPath, "99999999", "utf8");
  const past = new Date(Date.now() - ageMs);
  utimesSync(lockPath, past, past);
}

test("stale lock reclaim: a lock file abandoned by a crashed process is reclaimed, so a later caller succeeds quickly rather than stalling for the full lock timeout", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableEvidenceReferenceStore(dir);
    plantLock(dir, "akilta-tenant-stale", 31_000);
    const startedAt = Date.now();
    const result = store.listByTenant(createTenantScope("akilta-tenant-stale").tenantId);
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(result, []);
    assert.ok(elapsedMs < 2000, `expected the stale lock to be reclaimed quickly, took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
