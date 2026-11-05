import { randomUUID } from "node:crypto";
import { createAuthorityContext, type AuthorityContext } from "../domain/authority.js";
import type { OutcomeJob } from "../domain/outcome-job.js";
import type { ConnectorConnectionInstance } from "../domain/integration-connector-catalog.js";
import type { PrebuiltConnectorDefinition } from "../domain/prebuilt-connector-definitions.js";
import type {
  ConnectorTransport,
  SecretResolver,
  CurrentConnectorConnectionReader,
} from "../domain/connector-execution.js";
import type { DurableWorkArtifactStore } from "../domain/durable-work-artifact-store.js";
import {
  runWebsiteBuildDarkExecution,
  approveWebsiteBuildDarkDelivery,
  WebsiteBuildDarkExecutionError,
} from "../application/website-build-dark-execution.js";
import {
  WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START,
  WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
  WEBSITE_BUILD_V1_RECIPE_ADMISSION,
  WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS,
  WEBSITE_BUILD_V1_BOUND_JOBS,
} from "../fixtures/website-build-v1-recipe-binding.js";
import type { IncomingRequestLike, OutgoingResponseLike } from "./request-handler.js";

/**
 * WEBSITE-BUILD-EXECUTION-FOUNDATION, checkpoint 3: the thin HTTP surface
 * over checkpoint 2's `runWebsiteBuildDarkExecution`/`approveWebsiteBuildDarkDelivery`
 * - the first point in this whole initiative reachable from outside a Node
 * process, so the real end-to-end chain can be driven over real HTTP.
 *
 * DELIBERATELY DARK, NEVER PRODUCTION: this module is never imported by
 * `http-server.ts` or `node-server-entrypoint.ts` (verified by this
 * repository's own boundary-scan convention - see
 * `tests/website-build-dark-route-boundary.test.ts`), mirroring
 * `internal-os-review-fixtures.ts`'s own "review fixtures only reachable
 * from the dev entrypoint" discipline. There is no session/customer
 * authentication here at all - `darkAuthority()` below is a single fixed,
 * full-access `AuthorityContext` scoped to the one bounded
 * `WEBSITE_BUILD_v1` reference tenant, exactly like
 * `internal-os-dev-main.ts`'s own `isProduction: false` fixture wiring.
 * This is acceptable ONLY because this route is never wired anywhere a
 * real customer or production deployment could reach it - the same floor
 * every other dark/dev-only module in this repository already relies on.
 *
 * The one genuinely NEW piece of state this module adds: an in-process
 * `Map<jobId, OutcomeJob>` holding a job once it reaches `VERIFIED`,
 * awaiting the separate approval call. This is intentionally NOT a durable
 * store - a real "pending customer review" durable primitive is its own,
 * separately-scoped future checkpoint (there is no `OutcomeJob` durable
 * store composed anywhere in this dark harness at all yet); losing it on
 * restart is an accepted, disclosed limitation of a single-process test
 * harness, not a silent gap.
 *
 * Does not dynamically compile a blueprint/plan per request (see the
 * exec-plan doc's own "Checkpoint 2" reasoning) - `requirementId` selects
 * among the fixed, already-admitted `WEBSITE_BUILD_v1` reference jobs; the
 * customer-supplied `briefText` becomes the AI prompt's own input content.
 */
export interface WebsiteBuildDarkRouteDeps {
  readonly workArtifactStore: DurableWorkArtifactStore;
  readonly connectorInstance: ConnectorConnectionInstance;
  readonly connectorDefinition: PrebuiltConnectorDefinition;
  readonly connectionStore: CurrentConnectorConnectionReader;
  readonly secretResolver: SecretResolver;
  readonly transport: ConnectorTransport;
  /** Defaults to `() => new Date().toISOString()`. Overridable for tests. */
  readonly clock?: () => string;
}

export const WEBSITE_BUILD_DARK_EXECUTE_PATH = "/dark/website-build/execute";
export const WEBSITE_BUILD_DARK_APPROVE_PATH = "/dark/website-build/approve";

function json(status: number, body: unknown): OutgoingResponseLike {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function darkAuthority(): AuthorityContext {
  return createAuthorityContext({
    tenantScope: WEBSITE_BUILD_V1_RECIPE_BINDING_COLD_START.tenantScope,
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions: true,
  });
}

function parseJsonObjectBody(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

function requireNonEmptyStringField(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createWebsiteBuildDarkRequestHandler(
  deps: WebsiteBuildDarkRouteDeps,
): (request: IncomingRequestLike) => OutgoingResponseLike {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const awaitingApproval = new Map<string, OutcomeJob>();

  function handleExecute(request: IncomingRequestLike): OutgoingResponseLike {
    const parsed = parseJsonObjectBody(request.body);
    if (parsed === undefined) {
      return json(400, { error: "body must be a JSON object" });
    }
    const { requirementId, briefText } = parsed;
    if (!requireNonEmptyStringField(requirementId)) {
      return json(400, { error: "requirementId must be a non-empty string" });
    }
    if (!requireNonEmptyStringField(briefText)) {
      return json(400, { error: "briefText must be a non-empty string" });
    }

    const spec = WEBSITE_BUILD_V1_RECIPE_BINDING_SPECS.find((s) => s.requirementId === requirementId);
    if (spec === undefined) {
      return json(404, { error: `no WEBSITE_BUILD_v1 requirement "${requirementId}"` });
    }
    const draftJob = WEBSITE_BUILD_V1_BOUND_JOBS.find((j) => (j.jobId as string) === (spec.specId as string));
    if (draftJob === undefined) {
      return json(404, { error: `no bound job for requirement "${requirementId}"` });
    }

    try {
      const result = runWebsiteBuildDarkExecution({
        authority: darkAuthority(),
        draftJob,
        spec,
        admission: WEBSITE_BUILD_V1_RECIPE_ADMISSION,
        briefText,
        connectorInstance: deps.connectorInstance,
        connectorDefinition: deps.connectorDefinition,
        requestingOwnership: WEBSITE_BUILD_V1_RECIPE_BINDING_OWNERSHIP,
        connectionStore: deps.connectionStore,
        secretResolver: deps.secretResolver,
        transport: deps.transport,
        workArtifactStore: deps.workArtifactStore,
        artifactId: `artifact-${randomUUID()}`,
        evidenceId: `evidence-${randomUUID()}`,
        verificationId: `verification-${randomUUID()}`,
        clock,
      });
      awaitingApproval.set(result.job.jobId as string, result.job);
      return json(200, {
        jobId: result.job.jobId,
        state: result.job.state,
        artifactId: result.artifact.artifactId,
        content: result.artifact.content,
      });
    } catch (error) {
      if (error instanceof WebsiteBuildDarkExecutionError) {
        return json(502, { error: error.message });
      }
      return json(500, { error: "execution failed" });
    }
  }

  function handleApprove(request: IncomingRequestLike): OutgoingResponseLike {
    const parsed = parseJsonObjectBody(request.body);
    if (parsed === undefined) {
      return json(400, { error: "body must be a JSON object" });
    }
    const { jobId, approverRef } = parsed;
    if (!requireNonEmptyStringField(jobId)) {
      return json(400, { error: "jobId must be a non-empty string" });
    }
    if (!requireNonEmptyStringField(approverRef)) {
      return json(400, { error: "approverRef must be a non-empty string" });
    }

    const verifiedJob = awaitingApproval.get(jobId);
    if (verifiedJob === undefined) {
      return json(404, { error: `no VERIFIED job "${jobId}" awaiting approval in this process` });
    }

    try {
      const closedJob = approveWebsiteBuildDarkDelivery({
        authority: darkAuthority(),
        verifiedJob,
        closureApprovalId: `closure-${randomUUID()}`,
        approvedAt: clock(),
        approverRef,
      });
      awaitingApproval.delete(jobId);
      return json(200, { jobId: closedJob.jobId, state: closedJob.state });
    } catch {
      return json(500, { error: "approval failed" });
    }
  }

  return (request: IncomingRequestLike): OutgoingResponseLike => {
    if (request.method === "POST" && request.path === WEBSITE_BUILD_DARK_EXECUTE_PATH) {
      return handleExecute(request);
    }
    if (request.method === "POST" && request.path === WEBSITE_BUILD_DARK_APPROVE_PATH) {
      return handleApprove(request);
    }
    return json(404, { error: "not found" });
  };
}
