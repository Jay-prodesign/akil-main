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

/**
 * E10: the smallest provider-neutral contract for a temporary
 * dependency/invoker failure. `TEMPORARY_FAILURE` is an explicit, bounded,
 * retryable, safe result value - not a thrown/unhandled exception and not
 * an authorization of any kind. It carries no `status`/`resolution`-shaped
 * field, so it can never be mistaken for or substituted into a
 * `BrainResolution`; only `applyEvent`'s RESOLVE handling in
 * `engineering-run-state.ts` can ever produce continuation authorization.
 */
export type InvokeOutcome =
  | { readonly status: "ACCEPTED" }
  | { readonly status: "TEMPORARY_FAILURE"; readonly reason: string; readonly retryable: true };

/**
 * Wraps `WorkerInvoker.invoke` so a temporary dependency/invoker failure
 * (a thrown error, a rejected promise, or an `{ accepted: false }` result)
 * always becomes an explicit `TEMPORARY_FAILURE` outcome instead of an
 * unhandled rejection - and never itself mutates or authorizes an
 * `EngineeringRunState`. Calling this again (a caller-driven retry) is
 * safe: each call is independent and this function never records or
 * dedupes anything, so it structurally cannot duplicate a continuation
 * authorization - only a durable RESOLVE event applied through
 * `applyEvent`, with its own idempotency-key dedup (E2), can do that.
 */
export async function invokeSafely(
  invoker: WorkerInvoker,
  input: { readonly taskId: string; readonly branch: string; readonly checkpointSha: string },
): Promise<InvokeOutcome> {
  try {
    const result = await invoker.invoke(input);
    if (!result.accepted) {
      return {
        status: "TEMPORARY_FAILURE",
        reason: "invoker did not accept the request",
        retryable: true,
      };
    }
    return { status: "ACCEPTED" };
  } catch (error) {
    return {
      status: "TEMPORARY_FAILURE",
      reason: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}
