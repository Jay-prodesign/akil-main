import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReviewerPolicyError,
  resolvePreV1Reviewer,
  defaultReviewerResolver,
  invokeSafely,
  type WorkerInvoker,
} from "../src/domain/worker-invoker.js";

const invokeInput = { taskId: "ENG-ORCH-001", branch: "claude/ENG-ORCH-001-task-packet", checkpointSha: "sha-1" };

test("E14: pre-V1, an explicit request for Codex as reviewer is rejected rather than silently downgraded (DEC-142)", () => {
  assert.throws(
    () => resolvePreV1Reviewer({ preV1: true, requested: "CODEX" }),
    ReviewerPolicyError,
  );
});

test("E14: pre-V1 with no explicit request resolves to Brain/ChatGPT", () => {
  assert.equal(resolvePreV1Reviewer({ preV1: true }), "BRAIN_CHATGPT");
});

test("E14: pre-V1 with Brain explicitly requested resolves to Brain/ChatGPT", () => {
  assert.equal(resolvePreV1Reviewer({ preV1: true, requested: "BRAIN_CHATGPT" }), "BRAIN_CHATGPT");
});

test("E14: post-V1 (preV1: false) still resolves to Brain/ChatGPT in this bounded slice (no post-V1 Codex activation implemented)", () => {
  assert.equal(resolvePreV1Reviewer({ preV1: false, requested: "CODEX" }), "BRAIN_CHATGPT");
});

test("defaultReviewerResolver delegates to resolvePreV1Reviewer", () => {
  assert.throws(
    () => defaultReviewerResolver.resolveReviewer({ preV1: true, requested: "CODEX" }),
    ReviewerPolicyError,
  );
  assert.equal(defaultReviewerResolver.resolveReviewer({ preV1: true }), "BRAIN_CHATGPT");
});

test("E10: a thrown invoker error becomes an explicit, bounded, retryable TEMPORARY_FAILURE, not an unhandled rejection", async () => {
  const failingInvoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async () => {
      throw new Error("dependency temporarily unavailable");
    },
  };
  const outcome = await invokeSafely(failingInvoker, invokeInput);
  assert.equal(outcome.status, "TEMPORARY_FAILURE");
  assert.equal((outcome as { retryable: true }).retryable, true);
  assert.equal((outcome as { reason: string }).reason, "dependency temporarily unavailable");
  // Structurally cannot be mistaken for authorization: no status/resolution
  // shape resembling a BrainResolution/PASS/RESUME_AUTHORIZED exists here.
  assert.equal("resolution" in outcome, false);
});

test("E10: a rejected/not-accepted invoker result also becomes TEMPORARY_FAILURE rather than a silent no-op", async () => {
  const rejectingInvoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async () => ({ accepted: false }),
  };
  const outcome = await invokeSafely(rejectingInvoker, invokeInput);
  assert.equal(outcome.status, "TEMPORARY_FAILURE");
  assert.equal((outcome as { retryable: true }).retryable, true);
});

test("E10: a retry after a temporary failure succeeds independently and does not duplicate or carry over any authorization", async () => {
  let callCount = 0;
  const flakyInvoker: WorkerInvoker = {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("temporary dependency failure");
      }
      return { accepted: true };
    },
  };
  const firstAttempt = await invokeSafely(flakyInvoker, invokeInput);
  assert.equal(firstAttempt.status, "TEMPORARY_FAILURE");

  const retry = await invokeSafely(flakyInvoker, invokeInput);
  assert.equal(retry.status, "ACCEPTED");
  assert.equal(callCount, 2);
  // ACCEPTED itself is not an authorization either - it carries no
  // resolution/decision shape; only a durable RESOLVE event applied
  // through applyEvent (engineering-run-state.ts) can authorize anything.
  assert.equal("resolution" in retry, false);
  assert.equal("decision" in retry, false);
});
