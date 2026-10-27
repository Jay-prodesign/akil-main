import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createBreakGlassAccessGrant,
  revokeBreakGlassAccessGrant,
  isBreakGlassAccessGrantActive,
  InvalidBreakGlassAccessGrantError,
  type BreakGlassAccessGrant,
} from "../src/domain/break-glass-support-access.js";
import {
  FileDurableBreakGlassAccessGrantStore,
  CorruptedBreakGlassAccessGrantLineError,
  DuplicateBreakGlassAccessGrantError,
  BreakGlassAccessGrantNotFoundError,
  InvalidDurableBreakGlassAccessGrantStoreError,
} from "../src/domain/durable-break-glass-access-grant-store.js";

/**
 * C7 (gap scan 2026-10-23): `FileDurableBreakGlassAccessGrantStore` -
 * mirrors `protected-decision-record-lifecycle.test.ts`'s own store
 * witnesses (create once, revise at most once ACTIVE -> REVOKED, latest
 * wins), plus `durable-audit-log.test.ts`'s restart-safety, corrupted-file
 * and cross-tenant witnesses.
 */

const SUPPORT_TENANT = createTenantScope("tenant-bg-store-support");
const TENANT_A = createTenantScope("tenant-bg-store-a");
const TENANT_B = createTenantScope("tenant-bg-store-b");

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "durable-break-glass-grant-"));
}

function grantFile(dir: string, tenantId: string): string {
  return join(dir, `${Buffer.from(tenantId, "utf8").toString("base64url")}.grant.jsonl`);
}

function grantFor(overrides: {
  grantId?: string;
  target?: typeof TENANT_A;
  scope?: ReadonlyArray<unknown>;
  consentRequired?: boolean;
  expiresAt?: string;
  grantedToRef?: string;
} = {}): BreakGlassAccessGrant {
  return createBreakGlassAccessGrant({
    grantId: overrides.grantId ?? "bg-grant-1",
    supportTenantScope: SUPPORT_TENANT,
    targetTenantScope: overrides.target ?? TENANT_A,
    grantedToRef: overrides.grantedToRef ?? "staff-support-1",
    grantedByRef: "staff-approver-1",
    reason: "investigating a customer-reported incident",
    scope: overrides.scope ?? ["TASK", "QUOTA"],
    consentRequired: overrides.consentRequired ?? false,
    expiresAt: overrides.expiresAt ?? "2026-10-27T12:00:00.000Z",
  });
}

function revoke(grant: BreakGlassAccessGrant, revokedAt = "2026-10-27T01:00:00.000Z"): BreakGlassAccessGrant {
  return revokeBreakGlassAccessGrant({ grant, revokedAt, revokedReason: "incident closed" });
}

function withDir(run: (dir: string) => void): void {
  const dir = freshDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("C7 grant store: putIfAbsentGrant/getGrant round-trip; an identical replay is an idempotent no-op", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    const grant = grantFor();
    const first = store.putIfAbsentGrant(grant);
    assert.equal(first.created, true);
    assert.deepEqual(first.value, grant);
    assert.deepEqual(store.getGrant(TENANT_A, "bg-grant-1"), grant);

    const replay = store.putIfAbsentGrant(grantFor());
    assert.equal(replay.created, false);
    assert.deepEqual(replay.value, grant);
    // Exactly one durable line, not two.
    assert.equal(readFileSync(grantFile(dir, TENANT_A.tenantId), "utf8").trim().split("\n").length, 1);
    assert.equal(store.getGrant(TENANT_A, "no-such-grant"), undefined);
  });
});

test("C7 grant store: a DIFFERENT grant under the same (targetTenantId, grantId) is rejected with DuplicateBreakGlassAccessGrantError, never overwritten", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor());
    assert.throws(() => store.putIfAbsentGrant(grantFor({ scope: ["TASK", "QUOTA", "AUDIT_EVIDENCE"] })), DuplicateBreakGlassAccessGrantError);
    assert.throws(() => store.putIfAbsentGrant(grantFor({ expiresAt: "2099-01-01T00:00:00.000Z" })), DuplicateBreakGlassAccessGrantError);
    assert.deepEqual(store.getGrant(TENANT_A, "bg-grant-1")?.scope, ["TASK", "QUOTA"]);
    assert.equal(store.getGrant(TENANT_A, "bg-grant-1")?.expiresAt, "2026-10-27T12:00:00.000Z");
  });
});

test("C7 grant store: putIfAbsentGrant rejects a REVOKED grant and any hand-built invalid grant before anything is written", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    assert.throws(() => store.putIfAbsentGrant(revoke(grantFor())), InvalidDurableBreakGlassAccessGrantStoreError);
    const invalid: ReadonlyArray<BreakGlassAccessGrant> = [
      { ...grantFor(), scope: [] },
      { ...grantFor(), scope: ["EVERYTHING" as never] },
      { ...grantFor(), reason: "   " },
      { ...grantFor(), expiresAt: "not-a-date" },
      { ...grantFor(), grantId: " bg-grant-1 " },
      { ...grantFor(), consentRequired: "yes" as never },
      { ...grantFor(), state: "ACTIVE", revokedAt: "2026-10-27T01:00:00.000Z" },
      { ...grantFor(), extra: "field" } as BreakGlassAccessGrant,
    ];
    for (const grant of invalid) {
      assert.throws(() => store.putIfAbsentGrant(grant), InvalidDurableBreakGlassAccessGrantStoreError, JSON.stringify(grant));
    }
    assert.equal(existsSync(grantFile(dir, TENANT_A.tenantId)), false);
  });
});

test("C7 grant store: reviseGrant with revokeBreakGlassAccessGrant records REVOKED once, and getGrant's latest-wins read returns the revision, not the original ACTIVE creation", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    const grant = grantFor();
    store.putIfAbsentGrant(grant);
    assert.equal(isBreakGlassAccessGrantActive(store.getGrant(TENANT_A, "bg-grant-1")!, "2026-10-27T00:30:00.000Z"), true);

    const revised = store.reviseGrant({ targetTenantScope: TENANT_A, grantId: "bg-grant-1", revise: (current) => revoke(current) });
    assert.equal(revised.created, true);
    assert.equal(revised.value.state, "REVOKED");
    const latest = store.getGrant(TENANT_A, "bg-grant-1");
    assert.equal(latest?.state, "REVOKED");
    assert.equal(latest?.revokedReason, "incident closed");
    assert.equal(isBreakGlassAccessGrantActive(latest!, "2026-10-27T00:30:00.000Z"), false);
    assert.deepEqual(latest, revoke(grant));
  });
});

test("C7 grant store: reviseGrant on a grant that does not exist throws BreakGlassAccessGrantNotFoundError and never calls revise", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    let called = false;
    assert.throws(
      () =>
        store.reviseGrant({
          targetTenantScope: TENANT_A,
          grantId: "bg-grant-missing",
          revise: (current) => {
            called = true;
            return revoke(current);
          },
        }),
      BreakGlassAccessGrantNotFoundError,
    );
    assert.equal(called, false);
    assert.equal(store.getGrant(TENANT_A, "bg-grant-missing"), undefined);
  });
});

test("C7 grant store: REVOKED is terminal - revoking again throws (from the domain), a different revision is rejected, and the SAME revision is an idempotent no-op", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor());
    const revokedOnce = store.reviseGrant({ targetTenantScope: TENANT_A, grantId: "bg-grant-1", revise: (current) => revoke(current) }).value;

    assert.throws(
      () => store.reviseGrant({ targetTenantScope: TENANT_A, grantId: "bg-grant-1", revise: (current) => revoke(current) }),
      InvalidBreakGlassAccessGrantError,
    );
    assert.throws(
      () =>
        store.reviseGrant({
          targetTenantScope: TENANT_A,
          grantId: "bg-grant-1",
          revise: (current) => ({ ...current, revokedAt: "2026-10-27T02:00:00.000Z" }),
        }),
      InvalidDurableBreakGlassAccessGrantStoreError,
    );
    const idempotent = store.reviseGrant({ targetTenantScope: TENANT_A, grantId: "bg-grant-1", revise: (current) => current });
    assert.equal(idempotent.created, false);
    assert.deepEqual(store.getGrant(TENANT_A, "bg-grant-1"), revokedOnce);
    assert.equal(readFileSync(grantFile(dir, TENANT_A.tenantId), "utf8").trim().split("\n").length, 2);
  });
});

test("C7 grant store: the only legitimate revision is ACTIVE -> REVOKED with every other field unchanged - extending expiry, widening scope, re-targeting or staying ACTIVE is rejected", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor());
    const illegal: ReadonlyArray<(current: BreakGlassAccessGrant) => BreakGlassAccessGrant> = [
      (current) => ({ ...current, expiresAt: "2099-01-01T00:00:00.000Z" }),
      (current) => ({ ...current, scope: ["TASK", "QUOTA", "CONNECTION"] }),
      (current) => ({ ...revoke(current), expiresAt: "2099-01-01T00:00:00.000Z" }),
      (current) => ({ ...revoke(current), grantedToRef: "staff-someone-else" }),
      (current) => ({ ...revoke(current), consentRequired: true }),
    ];
    for (const revise of illegal) {
      assert.throws(() => store.reviseGrant({ targetTenantScope: TENANT_A, grantId: "bg-grant-1", revise }), InvalidDurableBreakGlassAccessGrantStoreError);
    }
    assert.throws(
      () => store.reviseGrant({ targetTenantScope: TENANT_A, grantId: "bg-grant-1", revise: (current) => ({ ...revoke(current), targetTenantId: TENANT_B.tenantId }) }),
      InvalidDurableBreakGlassAccessGrantStoreError,
    );
    assert.deepEqual(store.getGrant(TENANT_A, "bg-grant-1"), grantFor());
  });
});

test("C7 grant store: restart-safety - a fresh store instance over the same baseDir reconstructs identical state, including a revision", () => {
  withDir((dir) => {
    const first = new FileDurableBreakGlassAccessGrantStore(dir);
    first.putIfAbsentGrant(grantFor({ grantId: "bg-grant-restart-1" }));
    first.putIfAbsentGrant(grantFor({ grantId: "bg-grant-restart-2", scope: ["CONNECTION"] }));
    first.reviseGrant({ targetTenantScope: TENANT_A, grantId: "bg-grant-restart-2", revise: (current) => revoke(current) });

    const second = new FileDurableBreakGlassAccessGrantStore(dir);
    assert.deepEqual(second.getGrant(TENANT_A, "bg-grant-restart-1"), first.getGrant(TENANT_A, "bg-grant-restart-1"));
    assert.deepEqual(second.getGrant(TENANT_A, "bg-grant-restart-2"), revoke(grantFor({ grantId: "bg-grant-restart-2", scope: ["CONNECTION"] })));
    // A duplicate create is still rejected by the fresh instance.
    assert.throws(() => second.putIfAbsentGrant(grantFor({ grantId: "bg-grant-restart-1", scope: ["APPROVALS"] })), DuplicateBreakGlassAccessGrantError);
  });
});

test("C7 grant store: cross-tenant isolation - the same grantId under two target tenants are independent grants, and a lookup under tenant B never sees tenant A's grant", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor({ grantId: "bg-grant-shared", target: TENANT_A, scope: ["TASK"] }));
    assert.equal(store.getGrant(TENANT_B, "bg-grant-shared"), undefined);
    store.putIfAbsentGrant(grantFor({ grantId: "bg-grant-shared", target: TENANT_B, scope: ["AUDIT_EVIDENCE"] }));
    assert.deepEqual(store.getGrant(TENANT_A, "bg-grant-shared")?.scope, ["TASK"]);
    assert.deepEqual(store.getGrant(TENANT_B, "bg-grant-shared")?.scope, ["AUDIT_EVIDENCE"]);

    store.reviseGrant({ targetTenantScope: TENANT_A, grantId: "bg-grant-shared", revise: (current) => revoke(current) });
    assert.equal(store.getGrant(TENANT_A, "bg-grant-shared")?.state, "REVOKED");
    assert.equal(store.getGrant(TENANT_B, "bg-grant-shared")?.state, "ACTIVE");
  });
});

function assertCorruptedLine(line: string, label: string): void {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    writeFileSync(grantFile(dir, TENANT_A.tenantId), `${line}\n`, "utf8");
    assert.throws(() => store.getGrant(TENANT_A, "bg-grant-1"), CorruptedBreakGlassAccessGrantLineError, label);
  });
}

test("C7 grant store adversarial (corrupted file): every malformed persisted line fails closed with CorruptedBreakGlassAccessGrantLineError - never blind-cast", () => {
  const valid = grantFor();
  const line = (grant: unknown, grantId: unknown = "bg-grant-1"): string => JSON.stringify({ grantId, grant });
  const cases: ReadonlyArray<{ label: string; line: string }> = [
    { label: "not valid JSON", line: "{not json" },
    { label: "a JSON array line", line: JSON.stringify([valid]) },
    { label: "a primitive line", line: "42" },
    { label: "missing grant", line: JSON.stringify({ grantId: "bg-grant-1" }) },
    { label: "empty line key", line: line(valid, "") },
    { label: "line key does not match grant.grantId", line: line(valid, "bg-grant-other") },
    { label: "cross-tenant contamination (targetTenantId B in tenant A's file)", line: line({ ...valid, targetTenantId: TENANT_B.tenantId }) },
    { label: "unrecognized view kind in scope", line: line({ ...valid, scope: ["TASK", "EVERYTHING"] }) },
    { label: "empty scope", line: line({ ...valid, scope: [] }) },
    { label: "scope not an array", line: line({ ...valid, scope: "TASK" }) },
    { label: "missing expiresAt", line: line({ ...valid, expiresAt: undefined }) },
    { label: "invalid expiresAt", line: line({ ...valid, expiresAt: "tomorrow-ish" }) },
    { label: "empty reason", line: line({ ...valid, reason: "" }) },
    { label: "consentRequired not boolean", line: line({ ...valid, consentRequired: "false" }) },
    { label: "unknown state", line: line({ ...valid, state: "SUSPENDED" }) },
    { label: "ACTIVE carrying revocation metadata", line: line({ ...valid, revokedAt: "2026-10-27T01:00:00.000Z", revokedReason: "x" }) },
    { label: "REVOKED missing revokedReason", line: line({ ...valid, state: "REVOKED", revokedAt: "2026-10-27T01:00:00.000Z" }) },
    { label: "unknown extra field", line: line({ ...valid, superuser: true }) },
    { label: "whitespace-padded grantedToRef", line: line({ ...valid, grantedToRef: " staff-support-1 " }) },
    { label: "invalid supportTenantId", line: line({ ...valid, supportTenantId: "" }) },
  ];
  for (const entry of cases) {
    assertCorruptedLine(entry.line, entry.label);
  }
});

test("C7 grant store adversarial (corrupted file): one corrupted line poisons the whole tenant file (fail closed, never a silently-skipped line), while another tenant's file stays readable", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor({ target: TENANT_A }));
    store.putIfAbsentGrant(grantFor({ target: TENANT_B }));
    appendFileSync(grantFile(dir, TENANT_A.tenantId), "{broken\n", "utf8");
    assert.throws(() => store.getGrant(TENANT_A, "bg-grant-1"), CorruptedBreakGlassAccessGrantLineError);
    assert.equal(store.getGrant(TENANT_B, "bg-grant-1")?.targetTenantId, TENANT_B.tenantId);
  });
});
