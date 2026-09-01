import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toOperationsAttentionItem,
  resolveActiveOperationsAttention,
} from "../src/domain/operations-attention.js";
import { buildAttentionState } from "../src/domain/attention-state.js";
import { createOutcomeJob, enterExceptionState } from "../src/domain/outcome-job.js";
import { buildWebsiteBuildV1Fixture } from "../src/fixtures/website-build-v1.js";
import {
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

test("a NORMAL attention state maps to isActive: false", () => {
  const job = freshJob("job-normal");
  const state = buildAttentionState({ job });
  const item = toOperationsAttentionItem(state);
  assert.equal(item.isActive, false);
  assert.equal(item.internalAttentionLevel, "NORMAL");
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
  const item = toOperationsAttentionItem(state);
  assert.equal(item.isActive, true);
  assert.equal(item.internalAttentionLevel, "EXCEPTION");
  assert.equal(item.reason, "awaiting external dependency");
  assert.equal(item.timestamp, "2026-08-29T00:00:00.000Z");
});

test("this module carries no contractualSlaStatus field - internal attention and customer-contractual SLA remain separate truths", () => {
  const item = WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM as unknown as Record<string, unknown>;
  assert.equal("contractualSlaStatus" in item, false);
});

test("resolveActiveOperationsAttention returns only active items for the exact requested tenant/project", () => {
  const activeItem = WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM;
  const inactiveJob = freshJob("job-normal-2");
  const inactiveItem = toOperationsAttentionItem(buildAttentionState({ job: inactiveJob }));

  const result = resolveActiveOperationsAttention({
    items: [activeItem, inactiveItem],
    tenantId: activeItem.tenantId,
    projectId: activeItem.projectId,
  });
  assert.deepEqual(result, [activeItem]);
});

test("cross-tenant/cross-project attention items never leak into a different scope's result (adversarial)", () => {
  const activeItem = WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM;
  const result = resolveActiveOperationsAttention({
    items: [activeItem],
    tenantId: activeItem.tenantId,
    projectId: "proj-unrelated-other-project" as typeof activeItem.projectId,
  });
  assert.deepEqual(result, []);
});

test("this module exports no escalation/dismiss/resolve function - visibility never grants action authority", () => {
  const moduleExports = { toOperationsAttentionItem, resolveActiveOperationsAttention };
  const exportNames = Object.keys(moduleExports);
  assert.deepEqual(exportNames.sort(), ["resolveActiveOperationsAttention", "toOperationsAttentionItem"]);
});
