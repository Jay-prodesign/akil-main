import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createAuditEvent } from "../src/domain/audit-event.js";
import { DuplicateAuditEventError } from "../src/application/in-memory-audit-log.js";
import {
  FileDurableAuditLog,
  CorruptedAuditEventRecordFileError,
} from "../src/application/durable-audit-log.js";

/**
 * AUDIT-DURABLE-001: proves `FileDurableAuditLog` (the durable
 * implementation of the EXISTING `AuditLog` port) preserves
 * `InMemoryAuditLog`'s own append-only/no-overwrite/tenant-scoped
 * semantics exactly - same `DuplicateAuditEventError` type, same
 * `findByTenant` contract - while adding real restart-safety and
 * corrupted-file fail-closed replay validation, mirroring every other
 * file-durable store in this repository.
 */

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "durable-audit-log-"));
}

function jobIn(tenantId: string, customerId = "cust-1", projectId = "proj-1", jobId = "job-1") {
  const tenantScope = createTenantScope(tenantId);
  const customer = createCustomer({ tenantScope, customerId, displayName: "Acme Corp" });
  const project = createProject({ tenantScope, customer, projectId, ownerRef: "owner-1", state: "ACTIVE" });
  const job = createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Verify durable audit log end to end",
  });
  return { tenantScope, job };
}

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

test("save/find round-trip: an appended event is found via findByTenant", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-1");
    const log = new FileDurableAuditLog(dir);
    const event = createAuditEvent({ job, eventId: "evt-1", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" });
    log.append(event);

    const found = log.findByTenant(tenantScope);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0], event);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("append-only: a duplicate eventId is rejected with DuplicateAuditEventError, not overwritten", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-2");
    const log = new FileDurableAuditLog(dir);
    const event = createAuditEvent({ job, eventId: "evt-2", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" });
    log.append(event);
    assert.throws(() => log.append(event), DuplicateAuditEventError);
    assert.equal(log.findByTenant(tenantScope).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns an empty list for a tenant with no recorded events", () => {
  const dir = freshDir();
  try {
    const { tenantScope } = jobIn("tenant-audit-3");
    const log = new FileDurableAuditLog(dir);
    assert.deepEqual(log.findByTenant(tenantScope), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cross-tenant isolation: findByTenant for tenant A never returns tenant B's events", () => {
  const dir = freshDir();
  try {
    const a = jobIn("tenant-audit-4a");
    const b = jobIn("tenant-audit-4b");
    const log = new FileDurableAuditLog(dir);
    log.append(createAuditEvent({ job: a.job, eventId: "evt-4a", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" }));
    log.append(createAuditEvent({ job: b.job, eventId: "evt-4b", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" }));

    const aEvents = log.findByTenant(a.tenantScope);
    assert.equal(aEvents.length, 1);
    assert.equal(aEvents[0]?.eventId, "evt-4a");
    const bEvents = log.findByTenant(b.tenantScope);
    assert.equal(bEvents.length, 1);
    assert.equal(bEvents[0]?.eventId, "evt-4b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple events for the same tenant are all preserved, in append order", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-5");
    const log = new FileDurableAuditLog(dir);
    log.append(createAuditEvent({ job, eventId: "evt-5-1", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" }));
    log.append(createAuditEvent({ job, eventId: "evt-5-2", actorRef: "engineer:claude", eventType: "EXCEPTION_STATE_ENTERED:BLOCKED", timestamp: "2026-10-16T00:01:00.000Z" }));

    const events = log.findByTenant(tenantScope);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.eventId), ["evt-5-1", "evt-5-2"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restart-safety: a fresh store instance over the same baseDir reconstructs the identical event list", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-6");
    const log = new FileDurableAuditLog(dir);
    log.append(createAuditEvent({ job, eventId: "evt-6", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" }));

    const freshLog = new FileDurableAuditLog(dir);
    const events = freshLog.findByTenant(tenantScope);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventId, "evt-6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial (corrupted file): not valid JSON fails closed with CorruptedAuditEventRecordFileError", () => {
  const dir = freshDir();
  try {
    const { tenantScope } = jobIn("tenant-audit-7");
    mkdirSync(dir, { recursive: true });
    writeFileSync(tenantFilePath(dir, tenantScope.tenantId), "{ not valid json", "utf8");
    const log = new FileDurableAuditLog(dir);
    assert.throws(() => log.findByTenant(tenantScope), CorruptedAuditEventRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial (corrupted file): a JSON object instead of an array fails closed", () => {
  const dir = freshDir();
  try {
    const { tenantScope } = jobIn("tenant-audit-8");
    mkdirSync(dir, { recursive: true });
    writeFileSync(tenantFilePath(dir, tenantScope.tenantId), JSON.stringify({ not: "an array" }), "utf8");
    const log = new FileDurableAuditLog(dir);
    assert.throws(() => log.findByTenant(tenantScope), CorruptedAuditEventRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial (corrupted file): a record whose own tenantId does not match the tenant file it was read from fails closed (cross-tenant contamination)", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-9");
    const log = new FileDurableAuditLog(dir);
    const event = createAuditEvent({ job, eventId: "evt-9", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" });
    log.append(event);
    const filePath = tenantFilePath(dir, tenantScope.tenantId);
    const tampered = [{ ...event, tenantId: "tenant-audit-9-WRONG" }];
    writeFileSync(filePath, JSON.stringify(tampered), "utf8");
    assert.throws(() => log.findByTenant(tenantScope), CorruptedAuditEventRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial (corrupted file): an empty/whitespace actorRef fails closed", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-10");
    const log = new FileDurableAuditLog(dir);
    const event = createAuditEvent({ job, eventId: "evt-10", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" });
    log.append(event);
    const filePath = tenantFilePath(dir, tenantScope.tenantId);
    const tampered = [{ ...event, actorRef: "   " }];
    writeFileSync(filePath, JSON.stringify(tampered), "utf8");
    assert.throws(() => log.findByTenant(tenantScope), CorruptedAuditEventRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial (corrupted file): a leading/trailing-whitespace-corrupted eventType fails closed (canonical trim invariant)", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-11");
    const log = new FileDurableAuditLog(dir);
    const event = createAuditEvent({ job, eventId: "evt-11", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" });
    log.append(event);
    const filePath = tenantFilePath(dir, tenantScope.tenantId);
    const tampered = [{ ...event, eventType: " JOB_CREATED " }];
    writeFileSync(filePath, JSON.stringify(tampered), "utf8");
    assert.throws(() => log.findByTenant(tenantScope), CorruptedAuditEventRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial (corrupted file): relatedRefs that is not an array fails closed", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-12");
    const log = new FileDurableAuditLog(dir);
    const event = createAuditEvent({ job, eventId: "evt-12", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z" });
    log.append(event);
    const filePath = tenantFilePath(dir, tenantScope.tenantId);
    const tampered = [{ ...event, relatedRefs: "not-an-array" }];
    writeFileSync(filePath, JSON.stringify(tampered), "utf8");
    assert.throws(() => log.findByTenant(tenantScope), CorruptedAuditEventRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial (corrupted file): a relatedRefs element that is empty/whitespace fails closed", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-13");
    const log = new FileDurableAuditLog(dir);
    const event = createAuditEvent({ job, eventId: "evt-13", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z", relatedRefs: ["ref-1"] });
    log.append(event);
    const filePath = tenantFilePath(dir, tenantScope.tenantId);
    const tampered = [{ ...event, relatedRefs: ["   "] }];
    writeFileSync(filePath, JSON.stringify(tampered), "utf8");
    assert.throws(() => log.findByTenant(tenantScope), CorruptedAuditEventRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adversarial (corrupted file): a whitespace-corrupted optional reason fails closed", () => {
  const dir = freshDir();
  try {
    const { tenantScope, job } = jobIn("tenant-audit-14");
    const log = new FileDurableAuditLog(dir);
    const event = createAuditEvent({ job, eventId: "evt-14", actorRef: "engineer:claude", eventType: "JOB_CREATED", timestamp: "2026-10-16T00:00:00.000Z", reason: "ok" });
    log.append(event);
    const filePath = tenantFilePath(dir, tenantScope.tenantId);
    const tampered = [{ ...event, reason: " ok " }];
    writeFileSync(filePath, JSON.stringify(tampered), "utf8");
    assert.throws(() => log.findByTenant(tenantScope), CorruptedAuditEventRecordFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
