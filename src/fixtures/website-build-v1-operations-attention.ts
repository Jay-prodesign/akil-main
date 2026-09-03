import { buildWebsiteBuildV1Fixture } from "./website-build-v1.js";
import { createOutcomeJob, enterExceptionState, type OutcomeJob } from "../domain/outcome-job.js";
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
 * Both the resulting job and its exact `AuditEvent` are exported (Rev28
 * bounded correction) so `toOperationsAttentionItem` below can reuse the
 * job's authoritative `customerId` directly rather than having one
 * independently supplied or guessed.
 */
const websiteBuildV1AttentionTransition = enterExceptionState({
  job: createOutcomeJob({
    tenantScope: fixture.tenantScope,
    customer: fixture.customer,
    project: fixture.project,
    jobId: "job-website-build-v1-attention-fixture",
    jobFamily: "website-build-v1",
    businessObjective: "reference fixture for operations-attention aggregation",
  }),
  to: "BLOCKED",
  eventId: "evt-website-build-v1-attention-fixture",
  actorRef: "system-reference-fixture",
  timestamp: "2026-08-29T00:00:00.000Z",
  reason: "reference fixture: awaiting external dependency",
});

export const WEBSITE_BUILD_V1_ATTENTION_JOB: OutcomeJob = websiteBuildV1AttentionTransition.job;

export const WEBSITE_BUILD_V1_ATTENTION_STATE: AttentionState = buildAttentionState({
  job: WEBSITE_BUILD_V1_ATTENTION_JOB,
  latestExceptionEvent: websiteBuildV1AttentionTransition.auditEvent,
});

/**
 * Canonical WEBSITE_BUILD_v1 operations-attention fixture, reusing the
 * existing attention-state/job fixtures verbatim.
 */
export const WEBSITE_BUILD_V1_OPERATIONS_ATTENTION_ITEM: OperationsAttentionItem =
  toOperationsAttentionItem({
    state: WEBSITE_BUILD_V1_ATTENTION_STATE,
    job: WEBSITE_BUILD_V1_ATTENTION_JOB,
  });
