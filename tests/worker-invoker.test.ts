import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReviewerPolicyError,
  resolvePreV1Reviewer,
  defaultReviewerResolver,
} from "../src/domain/worker-invoker.js";

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
