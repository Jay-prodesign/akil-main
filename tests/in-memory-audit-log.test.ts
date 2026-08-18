import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createAuditEvent } from "../src/domain/audit-event.js";
import {
  InMemoryAuditLog,
  DuplicateAuditEventError,
} from "../src/application/in-memory-audit-log.js";

function jobIn(tenantId: string) {
  const tenantScope = createTenantScope(tenantId);
  const customer = createCustomer({
    tenantScope,
    customerId: "cust-1",
    displayName: "Acme Corp",
  });
  const project = createProject({
    tenantScope,
    customer,
    projectId: "proj-1",
    ownerRef: "owner-1",
    state: "active",
  });
  const job = createOutcomeJob({
    tenantScope,
    customer,
    project,
    jobId: "job-1",
    jobFamily: "onboarding",
    businessObjective: "Verify tenant isolation kernel end to end",
  });
  return { tenantScope, job };
}

test("T10: findByTenant returns only events recorded for that tenant", () => {
  const a = jobIn("tenant-a");
  const b = jobIn("tenant-b");
  const log = new InMemoryAuditLog();

  log.append(
    createAuditEvent({
      job: a.job,
      eventId: "evt-a-1",
      actorRef: "engineer:claude",
      eventType: "JOB_CREATED",
      timestamp: "2026-08-16T00:00:00.000Z",
    }),
  );
  log.append(
    createAuditEvent({
      job: b.job,
      eventId: "evt-b-1",
      actorRef: "engineer:claude",
      eventType: "JOB_CREATED",
      timestamp: "2026-08-16T00:00:00.000Z",
    }),
  );

  const tenantAEvents = log.findByTenant(a.tenantScope);
  assert.equal(tenantAEvents.length, 1);
  assert.equal(tenantAEvents[0]?.eventId, "evt-a-1");

  const tenantBEvents = log.findByTenant(b.tenantScope);
  assert.equal(tenantBEvents.length, 1);
  assert.equal(tenantBEvents[0]?.eventId, "evt-b-1");
});

test("append-only: a duplicate eventId is rejected, not overwritten", () => {
  const { job } = jobIn("tenant-a");
  const log = new InMemoryAuditLog();
  const event = createAuditEvent({
    job,
    eventId: "evt-1",
    actorRef: "engineer:claude",
    eventType: "JOB_CREATED",
    timestamp: "2026-08-16T00:00:00.000Z",
  });
  log.append(event);
  assert.throws(() => log.append(event), DuplicateAuditEventError);
});

test("append-only: this class exposes no update or remove method", () => {
  const log = new InMemoryAuditLog();
  assert.equal(
    Reflect.has(Object.getPrototypeOf(log), "update"),
    false,
  );
  assert.equal(
    Reflect.has(Object.getPrototypeOf(log), "remove"),
    false,
  );
  assert.equal(
    Reflect.has(Object.getPrototypeOf(log), "delete"),
    false,
  );
});

test("returns an empty list for a tenant with no recorded events", () => {
  const { tenantScope } = jobIn("tenant-c");
  const log = new InMemoryAuditLog();
  assert.deepEqual(log.findByTenant(tenantScope), []);
});
