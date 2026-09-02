import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toOperationsAttentionItem,
  resolveActiveOperationsAttention,
  InvalidOperationsAttentionItemError,
} from "../src/domain/operations-attention.js";
import { buildAttentionState } from "../src/domain/attention-state.js";
import { createOutcomeJob, enterExceptionState } from "../src/domain/outcome-job.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  WEBSITE_BUILD_V1_ATTENTION_JOB,
  WEBSITE_BUILD_V1_ATTENTION_STATE,
  WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM,
} from "../src/fixtures/website-build-v1-operations-attention.js";

const fixture = buildWebsiteBuildV1Fixture();

function freshJob(jobId: string) {
  return createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId,
    jobFamily: "website-build-v1",
    businessObjective: "test objective",
  });
}

test("reference proof: the WEBSITE_BUILD_v1 operations-attention fixture is deterministic and reuses the existing attention-state fixture", () => {
  assert.equal(WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM.sourceDomain, "DELIVERY_OUTCOME_JOB");
  assert.equal(WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM.jobId, WEBSITE_BUILD_V1_ATTENTION_STATE.jobId);
  assert.equal(WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM.isActive, true);
});

test("Rev28 bounded correction: customerId is carried through verbatim from the given OutcomeJob, and evidenceFreshness is CURRENT when reason+timestamp are both present", () => {
  assert.equal(WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM.customerId, WEBSITE_BUILD_V1_ATTENTION_JOB.customerId);
  assert.equal(WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM.evidenceFreshness, "CURRENT");
});

test("a NORMAL attention state maps to isActive: false, customerId still carried, evidenceFreshness UNKNOWN (no attention claim to be fresh about)", () => {
  const job = freshJob("job-normal");
  const state = buildAttentionState({ job });
  const item = toOperationsAttentionItem({ state, job });
  assert.equal(item.isActive, false);
  assert.equal(item.internalAttentionLevel, "NORMAL");
  assert.equal(item.customerId, job.customerId);
  assert.equal(item.evidenceFreshness, "UNKNOWN");
});

test("a BLOCKED (exception) attention state maps to isActive: true, preserving reason/timestamp/owner verbatim", () => {
  const job = freshJob("job-blocked");
  const { job: blockedJob, auditEvent } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-1",
    actorRef: "system",
    timestamp: "2026-08-29T00:00:00.000Z",
    reason: "awaiting external dependency",
  });
  const state = buildAttentionState({ job: blockedJob, latestExceptionEvent: auditEvent });
  const item = toOperationsAttentionItem({ state, job: blockedJob });
  assert.equal(item.isActive, true);
  assert.equal(item.internalAttentionLevel, "EXCEPTION");
  assert.equal(item.reason, "awaiting external dependency");
  assert.equal(item.timestamp, "2026-08-29T00:00:00.000Z");
  assert.equal(item.evidenceFreshness, "CURRENT");
});

test("Rev28 bounded correction: an active exception state built WITHOUT a latestExceptionEvent (no reason/timestamp evidence) is UNKNOWN freshness, not silently treated as current", () => {
  const job = freshJob("job-blocked-no-evidence");
  const { job: blockedJob } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-2",
    actorRef: "system",
    timestamp: "2026-08-29T00:00:00.000Z",
    reason: "awaiting external dependency",
  });
  // Deliberately build the AttentionState without the exception AuditEvent,
  // reproducing the exact "active but no evidence supplied" gap Rev28 flagged.
  const state = buildAttentionState({ job: blockedJob });
  const item = toOperationsAttentionItem({ state, job: blockedJob });
  assert.equal(item.isActive, true);
  assert.equal(item.reason, undefined);
  assert.equal(item.timestamp, undefined);
  assert.equal(item.evidenceFreshness, "UNKNOWN");
});

test("Rev28 bounded correction: a job that does not identify the same jobId as the given AttentionState fails closed (no fabricated join)", () => {
  const job = freshJob("job-a");
  const state = buildAttentionState({ job });
  const foreignJob = freshJob("job-b");
  assert.throws(
    () => toOperationsAttentionItem({ state, job: foreignJob }),
    InvalidOperationsAttentionItemError,
  );
});

test("Rev28 bounded correction: a job belonging to a different tenant than the given AttentionState fails closed (no fabricated join)", () => {
  const job = freshJob("job-tenant-check");
  const state = buildAttentionState({ job });
  const foreignJob = { ...job, tenantId: "tenant-unrelated-other" } as typeof job;
  assert.throws(
    () => toOperationsAttentionItem({ state, job: foreignJob }),
    InvalidOperationsAttentionItemError,
  );
});

test("Rev28 bounded correction: a job belonging to a different project than the given AttentionState fails closed (no fabricated join)", () => {
  const job = freshJob("job-project-check");
  const state = buildAttentionState({ job });
  const foreignJob = { ...job, projectId: "proj-unrelated-other-project" } as typeof job;
  assert.throws(
    () => toOperationsAttentionItem({ state, job: foreignJob }),
    InvalidOperationsAttentionItemError,
  );
});

test("this module carries no contractualSlaStatus field - internal attention and customer-contractual SLA remain separate truths", () => {
  const item = WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM as unknown as Record<string, unknown>;
  assert.equal("contractualSlaStatus" in item, false);
});

test("resolveActiveOperationsAttention returns only active items for the exact requested tenant/customer/project", () => {
  const activeItem = WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM;
  const inactiveJob = freshJob("job-normal-2");
  const inactiveItem = toOperationsAttentionItem({
    state: buildAttentionState({ job: inactiveJob }),
    job: inactiveJob,
  });

  const result = resolveActiveOperationsAttention({
    items: [activeItem, inactiveItem],
    tenantId: activeItem.tenantId,
    customerId: activeItem.customerId,
    projectId: activeItem.projectId,
  });
  assert.deepEqual(result, [activeItem]);
});

test("cross-tenant/cross-project attention items never leak into a different scope's result (adversarial)", () => {
  const activeItem = WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM;
  const result = resolveActiveOperationsAttention({
    items: [activeItem],
    tenantId: activeItem.tenantId,
    customerId: activeItem.customerId,
    projectId: "proj-unrelated-other-project" as typeof activeItem.projectId,
  });
  assert.deepEqual(result, []);
});

test("Rev28 bounded correction: cross-customer attention leakage rejects even when tenant and project both match (two customers sharing a tenant/project id space)", () => {
  const activeItem = WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM;
  const foreignCustomerItem = {
    ...activeItem,
    customerId: "cust-unrelated-other" as typeof activeItem.customerId,
  };
  const result = resolveActiveOperationsAttention({
    items: [activeItem, foreignCustomerItem],
    tenantId: activeItem.tenantId,
    customerId: activeItem.customerId,
    projectId: activeItem.projectId,
  });
  assert.deepEqual(result, [activeItem]);
});

test("Rev28 bounded correction: two customers can genuinely share a tenant+project id space in this domain - the isolation is enforced by the filter, not by identifiers happening to differ", () => {
  const tenantScope = fixture.tenantScope;
  const otherCustomer = createCustomer({
    tenantScope,
    customerId: "cust-website-build-v1-other",
    displayName: "Reference Other Customer Co",
  });
  const otherProject = createProject({
    tenantScope,
    customer: otherCustomer,
    projectId: fixture.project.projectId,
    ownerRef: "owner-website-build-v1-other",
    state: "active",
  });
  const otherJob = createOutcomeJob({
    tenantScope,
    customer: otherCustomer,
    project: otherProject,
    jobId: "job-other-customer-same-project-id",
    jobFamily: "website-build-v1",
    businessObjective: "adversarial cross-customer isolation coverage",
  });
  const { job: blockedOtherJob, auditEvent } = enterExceptionState({
    job: otherJob,
    to: "BLOCKED",
    eventId: "evt-other-customer",
    actorRef: "system",
    timestamp: "2026-08-29T00:00:00.000Z",
    reason: "reference fixture: unrelated customer's own blocker",
  });
  const otherItem = toOperationsAttentionItem({
    state: buildAttentionState({ job: blockedOtherJob, latestExceptionEvent: auditEvent }),
    job: blockedOtherJob,
  });

  const activeItem = WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM;
  assert.equal(otherItem.tenantId, activeItem.tenantId);
  assert.equal(otherItem.projectId, activeItem.projectId);
  assert.notEqual(otherItem.customerId, activeItem.customerId);

  const result = resolveActiveOperationsAttention({
    items: [activeItem, otherItem],
    tenantId: activeItem.tenantId,
    customerId: activeItem.customerId,
    projectId: activeItem.projectId,
  });
  assert.deepEqual(result, [activeItem]);
});

test("this module exports no escalation/dismiss/resolve function - visibility never grants action authority", () => {
  const moduleExports = {
    toOperationsAttentionItem,
    resolveActiveOperationsAttention,
    InvalidOperationsAttentionItemError,
  };
  const exportNames = Object.keys(moduleExports);
  assert.deepEqual(
    exportNames.sort(),
    ["InvalidOperationsAttentionItemError", "resolveActiveOperationsAttention", "toOperationsAttentionItem"],
  );
});
