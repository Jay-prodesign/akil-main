import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createOutcomeJob } from "../src/domain/outcome-job.js";
import { createAuditEvent } from "../src/domain/audit-event.js";
import { buildDeliveryTimeline, InvalidDeliveryTimelineError } from "../src/domain/delivery-timeline.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");
const customerInA = createCustomer({
  tenantScope: tenantA,
  customerId: "cust-1",
  displayName: "Acme Corp",
});
const projectInA = createProject({
  tenantScope: tenantA,
  customer: customerInA,
  projectId: "proj-1",
  ownerRef: "owner-1",
  state: "active",
});
const jobInA = createOutcomeJob({
  tenantScope: tenantA,
  customer: customerInA,
  project: projectInA,
  jobId: "job-1",
  jobFamily: "onboarding",
  businessObjective: "Deliver the bounded slice",
});

const customerInB = createCustomer({
  tenantScope: tenantB,
  customerId: "cust-2",
  displayName: "Globex",
});
const projectInB = createProject({
  tenantScope: tenantB,
  customer: customerInB,
  projectId: "proj-2",
  ownerRef: "owner-2",
  state: "active",
});
const jobInB = createOutcomeJob({
  tenantScope: tenantB,
  customer: customerInB,
  project: projectInB,
  jobId: "job-2",
  jobFamily: "onboarding",
  businessObjective: "Foreign tenant job",
});

test("no audit events yields an empty timeline scoped to the project", () => {
  const timeline = buildDeliveryTimeline({ project: projectInA, auditEvents: [] });
  assert.deepEqual(timeline.entries, []);
  assert.equal(timeline.tenantId, "tenant-a");
  assert.equal(timeline.projectId, "proj-1");
});

test("T3: an event with an unmapped/unknown eventType is omitted (fails closed), not guessed", () => {
  const unknown = createAuditEvent({
    job: jobInA,
    eventId: "evt-unknown",
    actorRef: "system",
    eventType: "SOME_INTERNAL_EVENT_NOT_IN_THE_CLOSED_SET",
    timestamp: "2026-08-21T09:00:00Z",
  });
  const timeline = buildDeliveryTimeline({ project: projectInA, auditEvents: [unknown] });
  assert.deepEqual(timeline.entries, []);
});

test("T4: known eventTypes map deterministically to a closed-set customer category", () => {
  const blocked = createAuditEvent({
    job: jobInA,
    eventId: "evt-blocked",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
    timestamp: "2026-08-21T09:00:00Z",
  });
  const recovering = createAuditEvent({
    job: jobInA,
    eventId: "evt-recovering",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:RECOVERING",
    timestamp: "2026-08-21T09:01:00Z",
  });
  const escalated = createAuditEvent({
    job: jobInA,
    eventId: "evt-escalated",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:ESCALATED",
    timestamp: "2026-08-21T09:02:00Z",
  });
  const stopped = createAuditEvent({
    job: jobInA,
    eventId: "evt-stopped",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:STOPPED",
    timestamp: "2026-08-21T09:03:00Z",
  });
  const timeline = buildDeliveryTimeline({
    project: projectInA,
    auditEvents: [blocked, recovering, escalated, stopped],
  });
  assert.deepEqual(
    timeline.entries.map((entry) => entry.category),
    ["BLOCKER", "STATUS_UPDATE", "ACTION_REQUIRED", "BLOCKER"],
  );
});

test("entries are sorted ascending by timestamp regardless of input order", () => {
  const later = createAuditEvent({
    job: jobInA,
    eventId: "evt-2",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
    timestamp: "2026-08-21T12:00:00Z",
  });
  const earlier = createAuditEvent({
    job: jobInA,
    eventId: "evt-1",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
    timestamp: "2026-08-21T09:00:00Z",
  });
  const timeline = buildDeliveryTimeline({ project: projectInA, auditEvents: [later, earlier] });
  assert.deepEqual(
    timeline.entries.map((entry) => entry.eventId),
    ["evt-1", "evt-2"],
  );
});

test("T1/T2: reason, actorRef and relatedRefs never appear on a customer timeline entry", () => {
  const event = createAuditEvent({
    job: jobInA,
    eventId: "evt-1",
    actorRef: "internal-worker-42",
    eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
    timestamp: "2026-08-21T09:00:00Z",
    reason: "internal detail that must not reach the customer",
    relatedRefs: ["internal-ref-1"],
  });
  const timeline = buildDeliveryTimeline({ project: projectInA, auditEvents: [event] });
  const entry = timeline.entries[0]!;
  assert.deepEqual(Object.keys(entry).sort(), ["category", "eventId", "jobId", "timestamp"]);
  assert.equal("reason" in entry, false);
  assert.equal("actorRef" in entry, false);
  assert.equal("relatedRefs" in entry, false);
});

test("T5: rejects an audit event that belongs to a different tenant than the given project", () => {
  const foreignEvent = createAuditEvent({
    job: jobInB,
    eventId: "evt-x",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
    timestamp: "2026-08-21T09:00:00Z",
  });
  assert.throws(
    () => buildDeliveryTimeline({ project: projectInA, auditEvents: [foreignEvent] }),
    InvalidDeliveryTimelineError,
  );
});

test("T5: rejects an audit event that belongs to a different project within the same tenant", () => {
  const otherProjectInA = createProject({
    tenantScope: tenantA,
    customer: customerInA,
    projectId: "proj-other",
    ownerRef: "owner-1",
    state: "active",
  });
  const jobInOtherProject = createOutcomeJob({
    tenantScope: tenantA,
    customer: customerInA,
    project: otherProjectInA,
    jobId: "job-y",
    jobFamily: "onboarding",
    businessObjective: "Different project job",
  });
  const wrongProjectEvent = createAuditEvent({
    job: jobInOtherProject,
    eventId: "evt-y",
    actorRef: "system",
    eventType: "EXCEPTION_STATE_ENTERED:BLOCKED",
    timestamp: "2026-08-21T09:00:00Z",
  });
  assert.throws(
    () => buildDeliveryTimeline({ project: projectInA, auditEvents: [wrongProjectEvent] }),
    InvalidDeliveryTimelineError,
  );
});
