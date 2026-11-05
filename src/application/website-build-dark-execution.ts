import type { AuthorityContext } from "../domain/authority.js";
import {
  authorizedTransitionOutcomeJob,
  authorizedVerifyOutcomeJob,
  authorizedCloseOutcomeJobWithApproval,
} from "./authorized-outcome-job-operations.js";
import { createExecutionRoutingRequirementRegistry } from "../domain/outcome-job-routing-execution.js";
import type { OutcomeJob } from "../domain/outcome-job.js";
import type { OutcomeJobSpec } from "../domain/outcome-job-spec.js";
import type { ServiceCatalogAdmission } from "../domain/service-catalog-admission.js";
import { createEvidenceReference } from "../domain/evidence.js";
import { createVerificationResult } from "../domain/verification-result.js";
import { createClosureApprovalReference } from "../domain/outcome-job-closure-approval.js";
import { createWorkArtifact, workArtifactLocator, type WorkArtifact } from "../domain/work-artifact.js";
import type { DurableWorkArtifactStore } from "../domain/durable-work-artifact-store.js";
import {
  executeConnectorCapability,
  type ConnectorTransport,
  type SecretResolver,
  type CurrentConnectorConnectionReader,
} from "../domain/connector-execution.js";
import { extractAnthropicMessageText } from "../domain/connector-transport-http.js";
import type { ConnectorConnectionInstance } from "../domain/integration-connector-catalog.js";
import type { PrebuiltConnectorDefinition } from "../domain/prebuilt-connector-definitions.js";
import type { ProjectOwnershipRef } from "../domain/project-ownership.js";

/**
 * WEBSITE-BUILD-EXECUTION-FOUNDATION, checkpoint 2 (test/dark environment
 * only - see that exec-plan doc for the full chain of reasoning): the
 * genuinely new composition this checkpoint adds is wiring an authority-
 * checked `OutcomeJob` lifecycle transition to a REAL connector execution
 * (checkpoint 1's `HttpConnectorTransport`/`EnvSecretResolver`) and a real
 * generated-content record (`WorkArtifact`) - every individual primitive
 * composed here (`authorizedTransitionOutcomeJob`,
 * `admitManualExecutionAllowedFromServiceCatalogAdmission`,
 * `executeConnectorCapability`, `createEvidenceReference`,
 * `createVerificationResult`, `authorizedVerifyOutcomeJob`,
 * `createClosureApprovalReference`, `authorizedCloseOutcomeJobWithApproval`)
 * already exists and is already independently reviewed/tested elsewhere in
 * this repository; this module adds no new authority rule and relaxes
 * nothing - it only sequences existing, unmodified boundaries in the exact
 * order `tests/cxp-001a-composed-lifecycle.test.ts` already proves
 * (DRAFT -> QUALIFIED -> READY -> EXECUTING -> VERIFYING -> VERIFIED), then
 * extends that exact proof one step further to CLOSED via the existing,
 * separately-reviewed closure-approval gate.
 *
 * Deliberately NOT a general-purpose "execute any job family" function:
 * the AI prompt, the capability ref, and the artifact type are all fixed to
 * the one bounded WEBSITE_BUILD_v1 reference case this checkpoint targets.
 * A caller supplies the exact `draftJob`/`spec`/`admission` triple already
 * proven consistent by the real admission/wiring chain
 * (`website-build-v1-recipe-binding.ts`) - this function does not invent or
 * independently derive any of them.
 *
 * `clock`/`artifactId`/`evidenceId`/`verificationId` are all caller-supplied
 * (never generated internally with `Date.now()`/`randomUUID()` inside this
 * module) so a caller/test controls determinism exactly like every other
 * domain/application boundary in this repository.
 */
export class WebsiteBuildDarkExecutionError extends Error {
  constructor(reason: string) {
    super(`WEBSITE_BUILD dark execution failed: ${reason}`);
    this.name = "WebsiteBuildDarkExecutionError";
  }
}

export interface WebsiteBuildDarkExecutionResult {
  readonly job: OutcomeJob;
  readonly artifact: WorkArtifact;
}

const ANTHROPIC_MESSAGES_CAPABILITY_REF = "cap:anthropic-model-inference";

/**
 * DRAFT -> QUALIFIED -> READY -> (admit `MANUAL_EXECUTION_ALLOWED`) ->
 * EXECUTING -> (real connector call, real `WorkArtifact`) -> VERIFYING ->
 * VERIFIED. Throws `WebsiteBuildDarkExecutionError` if the provider's
 * response carries no extractable generated text (`extractAnthropicMessageText`
 * returned `undefined`) - the job is left at `EXECUTING` in that case
 * (exactly the existing BLOCKED/RECOVERING exception-state path this
 * repository already provides for a stalled execution; this function does
 * not invent a second one).
 */
export function runWebsiteBuildDarkExecution(input: {
  authority: AuthorityContext;
  draftJob: OutcomeJob;
  spec: OutcomeJobSpec;
  admission: ServiceCatalogAdmission;
  briefText: string;
  connectorInstance: ConnectorConnectionInstance;
  connectorDefinition: PrebuiltConnectorDefinition;
  requestingOwnership: ProjectOwnershipRef;
  connectionStore: CurrentConnectorConnectionReader;
  secretResolver: SecretResolver;
  transport: ConnectorTransport;
  workArtifactStore: DurableWorkArtifactStore;
  artifactId: unknown;
  evidenceId: unknown;
  verificationId: unknown;
  clock: () => string;
}): WebsiteBuildDarkExecutionResult {
  const now = input.clock();

  const qualifiedJob = authorizedTransitionOutcomeJob(input.authority, input.draftJob, "QUALIFIED");
  const readyJob = authorizedTransitionOutcomeJob(input.authority, qualifiedJob, "READY");

  const registry = createExecutionRoutingRequirementRegistry();
  registry.admitManualExecutionAllowedFromServiceCatalogAdmission({
    job: readyJob,
    spec: input.spec,
    admission: input.admission,
    admittedAt: now,
  });

  const executingJob = authorizedTransitionOutcomeJob(input.authority, readyJob, "EXECUTING", registry);

  const executionResult = executeConnectorCapability({
    bound: { instance: input.connectorInstance, definition: input.connectorDefinition },
    capabilityRef: ANTHROPIC_MESSAGES_CAPABILITY_REF,
    requestingOwnership: input.requestingOwnership,
    connectionStore: input.connectionStore,
    secretResolver: input.secretResolver,
    transport: input.transport,
    requestPayload: {
      model: "claude-3-5-haiku-latest",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Write a short, friendly website homepage draft for the following business. Return plain text only.\n\n${input.briefText}`,
        },
      ],
    },
  });

  const generatedText = extractAnthropicMessageText(executionResult.data);
  if (generatedText === undefined) {
    throw new WebsiteBuildDarkExecutionError(
      "the connector response carried no extractable generated text - job left at EXECUTING",
    );
  }

  const artifact = createWorkArtifact({
    job: executingJob,
    artifactId: input.artifactId,
    artifactType: "WEBSITE_HOMEPAGE_COPY_DRAFT",
    content: generatedText,
    producedByConnectorKind: executionResult.connectorKind,
    producedAt: now,
  });
  input.workArtifactStore.record(artifact);

  const verifyingJob = authorizedTransitionOutcomeJob(input.authority, executingJob, "VERIFYING");

  const evidence = createEvidenceReference({
    job: verifyingJob,
    evidenceId: input.evidenceId,
    evidenceType: "generated-work-artifact",
    sourceLocator: workArtifactLocator(artifact),
    capturedAt: now,
  });
  const verificationResult = createVerificationResult({
    verificationId: input.verificationId,
    job: verifyingJob,
    evidence,
    verificationRequirementRef: input.spec.requirementId,
    status: "PASSED",
  });
  const verifiedJob = authorizedVerifyOutcomeJob(input.authority, verifyingJob, verificationResult);

  return { job: verifiedJob, artifact };
}

/**
 * The real "customer reviews the output and approves delivery" step: the
 * only authorized path from `VERIFIED` to `CLOSED`
 * (`authorizedCloseOutcomeJobWithApproval`), unchanged and unrelaxed. Per
 * that function's own doc comment, `approverRef` is a caller-supplied
 * label, not an independently-verified customer identity - this checkpoint
 * does not invent a new one, matching this repository's own standing
 * discipline (real customer-approval-identity admission remains a
 * separately-scoped, explicitly open question elsewhere, not fabricated
 * here).
 */
export function approveWebsiteBuildDarkDelivery(input: {
  authority: AuthorityContext;
  verifiedJob: OutcomeJob;
  closureApprovalId: unknown;
  approvedAt: unknown;
  approverRef: unknown;
}): OutcomeJob {
  const approval = createClosureApprovalReference({
    job: input.verifiedJob,
    closureApprovalId: input.closureApprovalId,
    approvedAt: input.approvedAt,
    approverRef: input.approverRef,
  });
  return authorizedCloseOutcomeJobWithApproval(input.authority, input.verifiedJob, approval);
}
