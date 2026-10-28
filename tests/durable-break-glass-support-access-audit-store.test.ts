import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import {
  authorizeBreakGlassSupportAccess,
  createBreakGlassAccessGrant,
  type BreakGlassSupportAccessAudit,
  type BreakGlassSupportViewKind,
} from "../src/domain/break-glass-support-access.js";
import {
  FileDurableBreakGlassSupportAccessAuditStore,
  CorruptedBreakGlassSupportAccessAuditFileError,
  DuplicateBreakGlassSupportAccessAuditError,
  InvalidBreakGlassSupportAccessAuditError,
} from "../src/domain/durable-break-glass-support-access-audit-store.js";
import { DuplicateAuditEventError } from "../src/application/in-memory-audit-log.js";

/**
 * C7 (gap scan 2026-10-23): `FileDurableBreakGlassSupportAccessAuditStore` -
 * mirrors `durable-audit-log.test.ts`'s own witnesses (round-trip,
 * append-only duplicate rejection, GLOBAL - not per-tenant - uniqueness,
 * restart-safety, corrupted-file fail-closed replay, cross-tenant
 * isolation), plus two of `durable-audit-log-concurrency.test.ts`'s real
 * multi-process witnesses: concurrent different-auditRef appends into one
 * tenant file (no lost append) and the REV216 F1 cross-tenant same-auditRef
 * race (exactly one winner).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = join(HERE, "helpers", "break-glass-audit-race-worker.js");

const SUPPORT_TENANT = createTenantScope("tenant-bg-audit-support");
const TENANT_A = createTenantScope("tenant-bg-audit-a");
const TENANT_B = createTenantScope("tenant-bg-audit-b");

function freshDir(prefix = "durable-break-glass-audit-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tenantFile(dir: string, tenantId: string): string {
  return join(dir, `${Buffer.from(tenantId, "utf8").toString("base64url")}.json`);
}

function globalIndexFile(dir: string): string {
  return join(dir, "__global-audit-ref-index__.json");
}

/** A real audit record, produced by the real domain gate - never hand-built. */
function auditFor(auditRef: string, target: TenantScope = TENANT_A, requestedView: BreakGlassSupportViewKind = "TASK"): BreakGlassSupportAccessAudit {
  const grant = createBreakGlassAccessGrant({
    grantId: `bg-grant-for-${auditRef}`,
    supportTenantScope: SUPPORT_TENANT,
    targetTenantScope: target,
    grantedToRef: "staff-support-audit",
    grantedByRef: "staff-approver-audit",
    reason: "audit store witness",
    scope: ["TASK", "CONNECTION", "QUOTA", "APPROVALS", "AUDIT_EVIDENCE"],
    consentRequired: false,
    expiresAt: "2026-10-28T00:00:00.000Z",
  });
  const decision = authorizeBreakGlassSupportAccess({
    grant,
    targetTenantScope: target,
    currentPrincipalRef: "staff-support-audit",
    requestedView,
    auditRef,
    now: "2026-10-27T00:00:00.000Z",
  });
  assert.equal(decision.outcome, "GRANTED");
  return (decision as { audit: BreakGlassSupportAccessAudit }).audit;
}

function withDir(run: (dir: string) => void): void {
  const dir = freshDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("C7 audit store: append/findByTargetTenant round-trip", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    const audit = auditFor("audit-rt-1");
    store.append(audit);
    assert.deepEqual(store.findByTargetTenant(TENANT_A), [audit]);
  });
});

test("C7 audit store: returns an empty list for a target tenant with no recorded audits", () => {
  withDir((dir) => {
    assert.deepEqual(new FileDurableBreakGlassSupportAccessAuditStore(dir).findByTargetTenant(TENANT_B), []);
  });
});

test("C7 audit store: append-only - a duplicate auditRef is rejected with its own DuplicateBreakGlassSupportAccessAuditError (never DuplicateAuditEventError), not overwritten", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    store.append(auditFor("audit-dup-1", TENANT_A, "TASK"));
    let caught: unknown;
    try {
      store.append(auditFor("audit-dup-1", TENANT_A, "QUOTA"));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof DuplicateBreakGlassSupportAccessAuditError);
    assert.ok(!(caught instanceof DuplicateAuditEventError));
    const audits = store.findByTargetTenant(TENANT_A);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.requestedView, "TASK");
  });
});

test("C7 audit store (REV216 F1 parity): the same auditRef appended for a DIFFERENT target tenant is rejected - uniqueness is global, not tenant-scoped", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    store.append(auditFor("audit-global-1", TENANT_A));
    assert.throws(() => store.append(auditFor("audit-global-1", TENANT_B)), DuplicateBreakGlassSupportAccessAuditError);
    assert.equal(store.findByTargetTenant(TENANT_A).length, 1);
    assert.deepEqual(store.findByTargetTenant(TENANT_B), []);
    // And a fresh instance over the same baseDir enforces it too.
    assert.throws(() => new FileDurableBreakGlassSupportAccessAuditStore(dir).append(auditFor("audit-global-1", TENANT_B)), DuplicateBreakGlassSupportAccessAuditError);
  });
});

test("C7 audit store: cross-tenant isolation - findByTargetTenant for tenant A never returns tenant B's audits", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    store.append(auditFor("audit-iso-a1", TENANT_A));
    store.append(auditFor("audit-iso-b1", TENANT_B));
    store.append(auditFor("audit-iso-a2", TENANT_A));
    assert.deepEqual(store.findByTargetTenant(TENANT_A).map((audit) => audit.auditRef), ["audit-iso-a1", "audit-iso-a2"]);
    assert.deepEqual(store.findByTargetTenant(TENANT_B).map((audit) => audit.auditRef), ["audit-iso-b1"]);
    assert.ok(store.findByTargetTenant(TENANT_A).every((audit) => audit.targetTenantId === TENANT_A.tenantId));
  });
});

test("C7 audit store: restart-safety - a fresh store instance over the same baseDir reconstructs the identical audit list, in append order", () => {
  withDir((dir) => {
    const first = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    const kinds: ReadonlyArray<BreakGlassSupportViewKind> = ["TASK", "CONNECTION", "QUOTA", "APPROVALS", "AUDIT_EVIDENCE"];
    for (const [index, kind] of kinds.entries()) {
      first.append(auditFor(`audit-restart-${index}`, TENANT_A, kind));
    }
    const second = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    assert.deepEqual(second.findByTargetTenant(TENANT_A), first.findByTargetTenant(TENANT_A));
    assert.deepEqual(second.findByTargetTenant(TENANT_A).map((audit) => audit.requestedView), kinds);
  });
});

test("C7 audit store: append validates its input with the replay rules BEFORE writing - an invalid record is rejected and nothing (tenant file or global index) is written", () => {
  withDir((dir) => {
    const store = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    const valid = auditFor("audit-input-1");
    const invalid: ReadonlyArray<unknown> = [
      { ...valid, requestedView: "EVERYTHING" },
      { ...valid, auditRef: "" },
      { ...valid, auditRef: " audit-input-1 " },
      { ...valid, decidedByPrincipalRef: "   " },
      { ...valid, decidedAt: "not-a-date" },
      { ...valid, targetTenantId: "" },
      { ...valid, extra: true },
    ];
    for (const audit of invalid) {
      assert.throws(() => store.append(audit as BreakGlassSupportAccessAudit), InvalidBreakGlassSupportAccessAuditError, JSON.stringify(audit));
    }
    assert.equal(existsSync(tenantFile(dir, TENANT_A.tenantId)), false);
    assert.equal(existsSync(globalIndexFile(dir)), false);
  });
});

function assertCorruptedTenantFile(content: string, label: string): void {
  withDir((dir) => {
    const store = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    writeFileSync(tenantFile(dir, TENANT_A.tenantId), content, "utf8");
    assert.throws(() => store.findByTargetTenant(TENANT_A), CorruptedBreakGlassSupportAccessAuditFileError, label);
  });
}

test("C7 audit store adversarial (corrupted file): every malformed persisted tenant file fails closed with CorruptedBreakGlassSupportAccessAuditFileError - never blind-cast", () => {
  const valid = auditFor("audit-corrupt-1");
  const cases: ReadonlyArray<{ label: string; content: string }> = [
    { label: "not valid JSON", content: "[{not json" },
    { label: "a JSON object instead of an array", content: JSON.stringify(valid) },
    { label: "a primitive record", content: JSON.stringify(["x"]) },
    { label: "cross-tenant contamination (targetTenantId B in tenant A's file)", content: JSON.stringify([{ ...valid, targetTenantId: TENANT_B.tenantId }]) },
    { label: "unrecognized requestedView", content: JSON.stringify([{ ...valid, requestedView: "EVERYTHING" }]) },
    { label: "missing grantId", content: JSON.stringify([{ ...valid, grantId: undefined }]) },
    { label: "whitespace-padded decidedByPrincipalRef", content: JSON.stringify([{ ...valid, decidedByPrincipalRef: " staff-support-audit" }]) },
    { label: "invalid decidedAt", content: JSON.stringify([{ ...valid, decidedAt: "yesterday" }]) },
    { label: "invalid supportTenantId", content: JSON.stringify([{ ...valid, supportTenantId: 7 }]) },
    { label: "unknown extra field", content: JSON.stringify([{ ...valid, viewedEverything: true }]) },
  ];
  for (const entry of cases) {
    assertCorruptedTenantFile(entry.content, entry.label);
  }
});

test("C7 audit store adversarial (corrupted global index file): not valid JSON / not an array / a non-string entry fails closed on the next append, and nothing is appended", () => {
  for (const content of ["{not json", JSON.stringify({ refs: [] }), JSON.stringify([""])]) {
    withDir((dir) => {
      const store = new FileDurableBreakGlassSupportAccessAuditStore(dir);
      writeFileSync(globalIndexFile(dir), content, "utf8");
      assert.throws(() => store.append(auditFor("audit-index-1")), CorruptedBreakGlassSupportAccessAuditFileError, content);
      assert.equal(existsSync(tenantFile(dir, TENANT_A.tenantId)), false);
    });
  }
});

// --- real multi-process witnesses ---

interface WorkerOutcome {
  readonly label: string;
  readonly succeeded: boolean;
  readonly stderr: string;
}

function runWorker(args: ReadonlyArray<string>): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ label: args[args.length - 1] ?? "?", succeeded: code === 0, stderr });
    });
  });
}

async function race(workers: ReadonlyArray<{ label: string; targetTenantId: string; auditRef: string }>, storeDir: string): Promise<ReadonlyArray<WorkerOutcome>> {
  const readyDir = freshDir("bg-audit-race-ready-");
  const goDir = freshDir("bg-audit-race-go-");
  const goFile = join(goDir, "go");
  try {
    const promises = workers.map((worker) =>
      runWorker([storeDir, join(readyDir, `${worker.label}.ready`), goFile, worker.targetTenantId, worker.auditRef, worker.label]),
    );
    const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
    const readyDeadline = Date.now() + 10_000;
    for (const worker of workers) {
      while (!existsSync(join(readyDir, `${worker.label}.ready`))) {
        if (Date.now() > readyDeadline) {
          throw new Error(`worker ${worker.label} never announced readiness`);
        }
        Atomics.wait(sleepBuffer, 0, 0, 1);
      }
    }
    mkdirSync(goDir, { recursive: true });
    writeFileSync(goFile, "go", "utf8");
    return await Promise.all(promises);
  } finally {
    rmSync(readyDir, { recursive: true, force: true });
    rmSync(goDir, { recursive: true, force: true });
  }
}

const LABELS = ["A", "B", "C", "D", "E"];

test(
  "C7 audit store (multi-process): real concurrent writer processes appending DIFFERENT auditRefs into the SAME target-tenant file - every append survives, none lost to a torn read-modify-write",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("bg-audit-race-same-tenant-");
    try {
      const outcomes = await race(
        LABELS.map((label) => ({ label, targetTenantId: TENANT_A.tenantId, auditRef: `audit-race-${label}` })),
        storeDir,
      );
      assert.ok(outcomes.every((outcome) => outcome.succeeded), JSON.stringify(outcomes));
      const audits = new FileDurableBreakGlassSupportAccessAuditStore(storeDir).findByTargetTenant(TENANT_A);
      assert.deepEqual(audits.map((audit) => audit.auditRef).sort(), LABELS.map((label) => `audit-race-${label}`));
      assert.equal((JSON.parse(readFileSync(globalIndexFile(storeDir), "utf8")) as string[]).length, LABELS.length);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  },
);

test(
  "C7 audit store (multi-process, REV216 F1 bug class): real concurrent writer processes in DIFFERENT target tenants appending the SAME auditRef - exactly one succeeds, every other fails closed with DuplicateBreakGlassSupportAccessAuditError",
  { timeout: 30_000 },
  async () => {
    const storeDir = freshDir("bg-audit-race-cross-tenant-");
    try {
      const outcomes = await race(
        LABELS.map((label) => ({ label, targetTenantId: `tenant-bg-audit-race-${label}`, auditRef: "audit-race-shared" })),
        storeDir,
      );
      const succeeded = outcomes.filter((outcome) => outcome.succeeded);
      assert.equal(succeeded.length, 1, JSON.stringify(outcomes));
      for (const outcome of outcomes.filter((entry) => !entry.succeeded)) {
        assert.match(outcome.stderr, /DuplicateBreakGlassSupportAccessAuditError/, outcome.stderr);
      }
      const store = new FileDurableBreakGlassSupportAccessAuditStore(storeDir);
      const holders = LABELS.filter((label) =>
        store.findByTargetTenant(createTenantScope(`tenant-bg-audit-race-${label}`)).some((audit) => audit.auditRef === "audit-race-shared"),
      );
      assert.equal(holders.length, 1);
    } finally {
      rmSync(storeDir, { recursive: true, force: true });
    }
  },
);

test("stale lock reclaim: a lock file abandoned by a crashed process is reclaimed, so a later caller succeeds quickly rather than stalling for the full lock timeout", () => {
  const dir = freshDir();
  try {
    const store = new FileDurableBreakGlassSupportAccessAuditStore(dir);
    const lockPath = join(dir, ".locks", "__global__.lock");
    mkdirSync(join(dir, ".locks"), { recursive: true });
    writeFileSync(lockPath, "99999999", "utf8");
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);
    const startedAt = Date.now();
    const result = store.findByTargetTenant(createTenantScope("tenant-bg-audit-stale"));
    const elapsedMs = Date.now() - startedAt;
    assert.deepEqual(result, []);
    assert.ok(elapsedMs < 2000, `expected the stale lock to be reclaimed quickly, took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
