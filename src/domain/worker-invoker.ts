export class ReviewerPolicyError extends Error {
  constructor(reason: string) {
    super(`Reviewer policy violation: ${reason}`);
    this.name = "ReviewerPolicyError";
  }
}

/**
 * ENG-ORCH-001 "First bounded vertical slice" #10: provider-neutral
 * boundary interfaces only - no real worker/reviewer model-provider API
 * integration exists behind these in this bounded slice, for any vendor
 * (explicit non-scope). `WorkerInvoker.invoke` returning a rejected promise (a
 * temporary dependency/invoker failure) must never itself constitute or
 * imply a continuation authorization - only a durable `BrainResolution`,
 * applied through `applyEvent`, can do that (see `engineering-run-state.ts`).
 */
export type WorkerRole = "CLAUDE_PRIMARY_ENGINEER";
export type ReviewerRole = "BRAIN_CHATGPT" | "CODEX";

export interface WorkerInvoker {
  readonly role: WorkerRole;
  invoke(input: {
    readonly taskId: string;
    readonly branch: string;
    readonly checkpointSha: string;
  }): Promise<{ readonly accepted: boolean }>;
}

export interface ReviewerResolver {
  resolveReviewer(input: { readonly preV1: boolean; readonly requested?: ReviewerRole }): ReviewerRole;
}

/**
 * E14 / DEC-142: before AKILTA's canonical V1 exit/release checkpoint,
 * Codex dispatch/review is suspended - the only eligible reviewer is
 * Brain/ChatGPT, and an explicit request for Codex is rejected rather
 * than silently downgraded, so a caller cannot accidentally believe Codex
 * review occurred.
 */
export function resolvePreV1Reviewer(input: {
  readonly preV1: boolean;
  readonly requested?: ReviewerRole;
}): ReviewerRole {
  if (input.preV1 && input.requested === "CODEX") {
    throw new ReviewerPolicyError(
      "Codex is ineligible as reviewer before AKILTA's canonical V1 exit/release checkpoint (DEC-142)",
    );
  }
  return "BRAIN_CHATGPT";
}

export const defaultReviewerResolver: ReviewerResolver = {
  resolveReviewer: resolvePreV1Reviewer,
};
