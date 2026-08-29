import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createAuditEvent, InvalidAuditEventError } from "../src/domain/audit-event.js";

const tenantScope = createTenantScope("tenant-a");
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

test("T10: preserves tenant/job/project correlation from the given job", () => {
  const event = createAuditEvent({
    job,
    eventId: "evt-1",
    actorRef: "engineer:claude",
    eventType: "JOB_CREATED",
    timestamp: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(event.tenantId, job.tenantId);
  assert.equal(event.jobId, job.jobId);
  assert.equal(event.projectId, job.projectId);
});

test("creates an AuditEvent without a reason (optional) and default empty relatedRefs", () => {
  const event = createAuditEvent({
    job,
    eventId: "evt-1",
    actorRef: "engineer:claude",
    eventType: "JOB_CREATED",
    timestamp: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(event.reason, undefined);
  assert.deepEqual(event.relatedRefs, []);
});

test("creates an AuditEvent with a reason and relatedRefs", () => {
  const event = createAuditEvent({
    job,
    eventId: "evt-2",
    actorRef: "engineer:claude",
    eventType: "JOB_BLOCKED",
    timestamp: "2026-08-16T00:00:00.000Z",
    reason: "upstream dependency unavailable",
    relatedRefs: ["policy:retry-budget", "evidence:ev-1"],
  });
  assert.equal(event.reason, "upstream dependency unavailable");
  assert.deepEqual(event.relatedRefs, ["policy:retry-budget", "evidence:ev-1"]);
});

test("rejects a missing eventId", () => {
  assert.throws(
    () =>
      createAuditEvent({
        job,
        eventId: undefined,
        actorRef: "engineer:claude",
        eventType: "JOB_CREATED",
        timestamp: "2026-08-16T00:00:00.000Z",
      }),
    InvalidAuditEventError,
  );
});

test("rejects a non-array relatedRefs", () => {
  assert.throws(
    () =>
      createAuditEvent({
        job,
        eventId: "evt-3",
        actorRef: "engineer:claude",
        eventType: "JOB_CREATED",
        timestamp: "2026-08-16T00:00:00.000Z",
        relatedRefs: "policy:retry-budget",
      }),
    InvalidAuditEventError,
  );
});

test("rejects an empty-string element in relatedRefs", () => {
  assert.throws(
    () =>
      createAuditEvent({
        job,
        eventId: "evt-4",
        actorRef: "engineer:claude",
        eventType: "JOB_CREATED",
        timestamp: "2026-08-16T00:00:00.000Z",
        relatedRefs: ["policy:retry-budget", ""],
      }),
    InvalidAuditEventError,
  );
});
