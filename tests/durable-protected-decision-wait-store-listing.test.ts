import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantScope } from "../src/domain/tenant-scope.js";
import type {
  ProtectedDecisionWaitRequest,
  ProtectedDecisionResumeAuthorization,
} from "../src/domain/protected-decision-wait-gate.js";
import {
  FileDurableProtectedDecisionWaitStore,
  CorruptedProtectedDecisionWaitLineError,
} from "../src/domain/durable-protected-decision-wait-store.js";

/**
 * C3 Attention slice (gap scan 2026-10-23): the one bounded enumeration
 * method `FileDurableProtectedDecisionWaitStore` gains
 * (`DurableProtectedDecisionWaitListing.listByTenant`). Present, absent,
 * resumed, corrupted, cross-tenant, conflicting-duplicate and per-tenant
 * bound cases.
 */

const TENANT_A = "tenant-c3a-store-a" as TenantScope["tenantId"];
const TENANT_B = "tenant-c3a-store-b" as TenantScope["tenantId"];

function waitRequest(
  tenantId: string,
  waitRequestId: string,
  overrides: Partial<Omit<ProtectedDecisionWaitRequest, "tenantId" | "waitRequestId">> = {},
): ProtectedDecisionWaitRequest {
  return {
    waitRequestId: waitRequestId as ProtectedDecisionWaitRequest["waitRequestId"],
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: "customer-c3a" as ProtectedDecisionWaitRequest["customerId"],
    projectId: "project-c3a" as ProtectedDecisionWaitRequest["projectId"],
    jobId: "plan-c3a:v1:req-1" as ProtectedDecisionWaitRequest["jobId"],
    runId: "run-c3a-1",
    attempt: 1,
    effectRef: `effect:${waitRequestId}`,
    decisionRef: "decision:c3a",
    reason: "C3A reason",
    activationFingerprintAtWait: "fingerprint-c3a",
    raisedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

function resumeFor(request: ProtectedDecisionWaitRequest, overrides: Partial<ProtectedDecisionResumeAuthorization> = {}): ProtectedDecisionResumeAuthorization {
  return {
    waitRequestId: request.waitRequestId as unknown as ProtectedDecisionResumeAuthorization["waitRequestId"],
    effectRef: request.effectRef,
    resolvedAt: "2026-10-23T01:00:00.000Z",
    resolvedByPrincipalRef: "membership-c3a-approver",
    decisionRef: request.decisionRef,
    decisionEvidenceRef: "evidence:c3a-decision",
    ...overrides,
  };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "c3a-wait-listing-"));
}

function tenantKey(tenantId: string): string {
  return Buffer.from(tenantId, "utf8").toString("base64url");
}

function waitFile(dir: string, tenantId: string): string {
  return join(dir, `${tenantKey(tenantId)}.wait.jsonl`);
}

function resumeFile(dir: string, tenantId: string): string {
  return join(dir, `${tenantKey(tenantId)}.resume.jsonl`);
}

function withDir(run: (dir: string) => void): void {
  const dir = freshDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("C3A-ST1: listByTenant on a tenant with no files is an empty list, and reading creates no file", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    const before = readdirSync(dir).sort();
    assert.deepEqual(store.listByTenant(TENANT_A), []);
    assert.deepEqual(readdirSync(dir).sort(), before);
    assert.equal(existsSync(waitFile(dir, TENANT_A)), false);
  });
});

test("C3A-ST2: listByTenant returns each recorded wait once, in recorded order, with its resume when one was claimed - and survives a restart", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    const first = waitRequest(TENANT_A, "wait-c3a-1");
    const second = waitRequest(TENANT_A, "wait-c3a-2", { raisedAt: "2026-10-22T00:00:00.000Z" });
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-1", first);
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-2", second);
    const resume = resumeFor(second);
    store.claimResume(TENANT_A, "wait-c3a-2", resume);

    const expected = [{ request: first }, { request: second, resume }];
    assert.deepEqual(store.listByTenant(TENANT_A), expected);
    assert.equal("resume" in store.listByTenant(TENANT_A)[0]!, false, "an outstanding wait has no resume key at all");
    assert.deepEqual(new FileDurableProtectedDecisionWaitStore(dir).listByTenant(TENANT_A), expected);
  });
});

test("C3A-ST3: listByTenant is per tenant - another tenant's waits never appear", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-a", waitRequest(TENANT_A, "wait-c3a-a"));
    store.putIfAbsentWaitRequest(TENANT_B, "wait-c3a-b", waitRequest(TENANT_B, "wait-c3a-b"));
    assert.deepEqual(store.listByTenant(TENANT_A).map((entry) => entry.request.waitRequestId), ["wait-c3a-a"]);
    assert.deepEqual(store.listByTenant(TENANT_B).map((entry) => entry.request.waitRequestId), ["wait-c3a-b"]);
    assert.deepEqual(store.listByTenant("tenant-c3a-nobody" as TenantScope["tenantId"]), []);
  });
});

test("C3A-ST4: bounded - listByTenant reads only its own tenant's files, so a corrupted file of ANOTHER tenant does not affect it", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-a", waitRequest(TENANT_A, "wait-c3a-a"));
    writeFileSync(waitFile(dir, TENANT_B), "{ not json\n", "utf8");
    writeFileSync(resumeFile(dir, TENANT_B), "{ not json\n", "utf8");
    assert.deepEqual(store.listByTenant(TENANT_A).map((entry) => entry.request.waitRequestId), ["wait-c3a-a"]);
    assert.throws(() => store.listByTenant(TENANT_B), CorruptedProtectedDecisionWaitLineError);
  });
});

test("C3A-ST5: an idempotent re-put, and an identical re-appended line (the store's own crash reconciliation), still list the wait once", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    const request = waitRequest(TENANT_A, "wait-c3a-dup");
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-dup", request);
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-dup", request);
    appendFileSync(waitFile(dir, TENANT_A), `${JSON.stringify({ waitRequestId: "wait-c3a-dup", request })}\n`, "utf8");
    const resume = resumeFor(request);
    store.claimResume(TENANT_A, "wait-c3a-dup", resume);
    appendFileSync(resumeFile(dir, TENANT_A), `${JSON.stringify({ waitRequestId: "wait-c3a-dup", authorization: resume })}\n`, "utf8");
    assert.deepEqual(store.listByTenant(TENANT_A), [{ request, resume }]);
  });
});

test("C3A-ST6: listByTenant reads fresh on every call - a wait recorded through a second instance after the first list appears on the next list", () => {
  withDir((dir) => {
    const reader = new FileDurableProtectedDecisionWaitStore(dir);
    assert.deepEqual(reader.listByTenant(TENANT_A), []);
    new FileDurableProtectedDecisionWaitStore(dir).putIfAbsentWaitRequest(TENANT_A, "wait-c3a-late", waitRequest(TENANT_A, "wait-c3a-late"));
    assert.deepEqual(reader.listByTenant(TENANT_A).map((entry) => entry.request.waitRequestId), ["wait-c3a-late"]);
  });
});

test("C3A-ST7: a corrupted wait log throws CorruptedProtectedDecisionWaitLineError - never an empty list", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    for (const content of ["{ not json\n", "[]\n", "42\n", `${JSON.stringify({ waitRequestId: "w", request: { tenantId: TENANT_A } })}\n`]) {
      writeFileSync(waitFile(dir, TENANT_A), content, "utf8");
      assert.throws(() => store.listByTenant(TENANT_A), CorruptedProtectedDecisionWaitLineError, content);
    }
  });
});

test("C3A-ST8: a corrupted resume log throws too - even when the wait log is fine", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-r", waitRequest(TENANT_A, "wait-c3a-r"));
    writeFileSync(resumeFile(dir, TENANT_A), "{ not json\n", "utf8");
    assert.throws(() => store.listByTenant(TENANT_A), CorruptedProtectedDecisionWaitLineError);
    writeFileSync(resumeFile(dir, TENANT_A), `${JSON.stringify({ waitRequestId: "wait-c3a-r", authorization: { effectRef: "" } })}\n`, "utf8");
    assert.throws(() => store.listByTenant(TENANT_A), CorruptedProtectedDecisionWaitLineError);
  });
});

test("C3A-ST9: a foreign tenant's wait line inside this tenant's log fails closed (cross-tenant contamination), not silently dropped", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    const own = waitRequest(TENANT_A, "wait-c3a-own");
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-own", own);
    const foreign = waitRequest(TENANT_B, "wait-c3a-foreign");
    appendFileSync(waitFile(dir, TENANT_A), `${JSON.stringify({ waitRequestId: "wait-c3a-foreign", request: foreign })}\n`, "utf8");
    assert.throws(() => store.listByTenant(TENANT_A), (error: unknown) => {
      assert.ok(error instanceof CorruptedProtectedDecisionWaitLineError);
      assert.match(error.message, /cross-tenant contamination/);
      return true;
    });
  });
});

test("C3A-ST10: two DIFFERENT wait lines for one waitRequestId fail closed (get() would silently take the first)", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    const original = waitRequest(TENANT_A, "wait-c3a-conflict");
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-conflict", original);
    const tampered = { ...original, decisionRef: "decision:tampered" };
    appendFileSync(waitFile(dir, TENANT_A), `${JSON.stringify({ waitRequestId: "wait-c3a-conflict", request: tampered })}\n`, "utf8");
    assert.deepEqual(store.get(TENANT_A, "wait-c3a-conflict"), original, "existing exact-id lookup is unchanged");
    assert.throws(() => store.listByTenant(TENANT_A), CorruptedProtectedDecisionWaitLineError);
  });
});

test("C3A-ST11: two DIFFERENT resume lines for one waitRequestId fail closed", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    const request = waitRequest(TENANT_A, "wait-c3a-rconflict");
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-rconflict", request);
    store.claimResume(TENANT_A, "wait-c3a-rconflict", resumeFor(request));
    const other = resumeFor(request, { resolvedByPrincipalRef: "membership-c3a-someone-else" });
    appendFileSync(resumeFile(dir, TENANT_A), `${JSON.stringify({ waitRequestId: "wait-c3a-rconflict", authorization: other })}\n`, "utf8");
    assert.throws(() => store.listByTenant(TENANT_A), CorruptedProtectedDecisionWaitLineError);
  });
});

test("C3A-ST12: a resume line naming a different effectRef than its wait fails closed (claimResume refuses this on write)", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    const request = waitRequest(TENANT_A, "wait-c3a-effect");
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-effect", request);
    const mismatched = resumeFor(request, { effectRef: "effect:someone-elses" });
    appendFileSync(resumeFile(dir, TENANT_A), `${JSON.stringify({ waitRequestId: "wait-c3a-effect", authorization: mismatched })}\n`, "utf8");
    assert.throws(() => store.listByTenant(TENANT_A), CorruptedProtectedDecisionWaitLineError);
  });
});

test("C3A-ST13: a resume line with no matching wait is ignored - it cannot make anything look resolved, and it is not listed as a wait", () => {
  withDir((dir) => {
    const store = new FileDurableProtectedDecisionWaitStore(dir);
    const pending = waitRequest(TENANT_A, "wait-c3a-pending");
    store.putIfAbsentWaitRequest(TENANT_A, "wait-c3a-pending", pending);
    const orphan = resumeFor(waitRequest(TENANT_A, "wait-c3a-orphan"));
    appendFileSync(resumeFile(dir, TENANT_A), `${JSON.stringify({ waitRequestId: "wait-c3a-orphan", authorization: orphan })}\n`, "utf8");
    assert.deepEqual(store.listByTenant(TENANT_A), [{ request: pending }]);
  });
});
