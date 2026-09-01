import { buildWebsiteBuildV1Fixture } from "./website-build-v1.js";
import { createOutcomeJob, enterExceptionState } from "../domain/outcome-job.js";
import { buildAttentionState, type AttentionState } from "../domain/attention-state.js";
import {
  toOperationsAttentionItem,
  type OperationsAttentionItem,
} from "../domain/operations-attention.js";

const fixture = buildWebsiteBuildV1Fixture();

/**
 * A WEBSITE_BUILD_v1 job placed into an exception state, reusing the
 * exact same `AttentionState` construction pattern already established
 * by V3-SLA-001 - no parallel job or exception-state fixture invented.
 */
export const WEBSITE_BUILD_V1_ATTENTION_STATE: AttentionState = (() => {
  const job = createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-website-build-v1-attention-fixture",
    jobFamily: "website-build-v1",
    businessObjective: "reference fixture for operations-attention aggregation",
  });
  const { job: blockedJob, auditEvent } = enterExceptionState({
    job,
    to: "BLOCKED",
    eventId: "evt-website-build-v1-attention-fixture",
    actorRef: "system-reference-fixture",
    timestamp: "2026-08-29T00:00:00.000Z",
    reason: "reference fixture: awaiting external dependency",
  });
  return buildAttentionState({ job: blockedJob, latestExceptionEvent: auditEvent });
})();

/**
 * Canonical WEBSITE_BUILD_v1 operations-attention fixture, reusing the
 * existing attention-state fixture verbatim.
 */
export const WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM: OperationsAttentionItem =
  toOperationsAttentionItem(WEBSITE_BUILD_V1_ATTENTION_STATE);
