import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import {
  createConnectionRequirement,
  createConnectionBinding,
  transitionConnectionBinding,
  verifyConnectionBinding,
  type ConnectionBinding,
} from "../src/domain/connection-authority.js";
import { transitionOutcomeJob, verifyOutcomeJob } from "../src/domain/outcome-job.js";
import { createEvidenceReference } from "../src/domain/evidence.js";
import { createVerificationResult } from "../src/domain/verification-result.js";
import {
  bootstrapExternalSaleOutcome,
  applyExternalSaleDisposition,
  InvalidExternalSaleBootstrapError,
} from "../src/domain/external-sale-bootstrap.js";

function baseFixture(tenantSuffix = "a") {
  const tenantScope = createTenantScope(`tenant-sale-${tenantSuffix}`);
  const customer = createCustomer({
    tenantScope,
    customerId: `cust-sale-${tenantSuffix}`,
    displayName: "Sale Customer",
  });
  const ownership = createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: `sale-project:order-${tenantSuffix}-1`,
  });
  return { tenantScope, customer, ownership };
}

function verifiedConnection(ownership: ReturnType<typeof createProjectOwnershipRef>): ConnectionBinding {
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-${ownership.tenantId}`,
    ownership,
    requiredCapabilityRef: "required-access-connections",
    purpose: "vouch for external sale facts",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH2",
    validationRequirement: "provider-verified",
  });
  const requested = createConnectionBinding({
    connectionBindingId: `bind-${ownership.tenantId}`,
    requirement,
    ownership,
    providerRef: "SHOPIFY",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
  });
  const unverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectionBinding(unverified, "evidence:provider-handshake");
}

test("R1: bootstrapExternalSaleOutcome creates Project+SoldScope+OutcomeJob deterministically from externalSaleRef", () => {
  const { tenantScope, customer, ownership } = baseFixture();
  const connection = verifiedConnection(ownership);

  const result = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    connection,
    externalSaleRef: "order-1001",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });

  assert.equal(result.project.projectId, "sale-project:order-1001");
  assert.equal(result.soldScope.soldScopeId, "sale-scope:order-1001");
  assert.equal(result.job.jobId, "sale-job:order-1001");
  assert.equal(result.job.state, "DRAFT");
  assert.equal(result.soldScope.projectId, result.project.projectId);
});

test("R2: replaying bootstrapExternalSaleOutcome with the same externalSaleRef produces a byte-for-byte identical result (pure idempotent function)", () => {
  const { tenantScope, customer, ownership } = baseFixture();
  const connection = verifiedConnection(ownership);
  const input = {
    tenantScope,
    customer,
    connection,
    externalSaleRef: "order-replay-1",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  };

  const first = bootstrapExternalSaleOutcome(input);
  const second = bootstrapExternalSaleOutcome(input);

  assert.deepEqual(first, second);
});

test("R3: a connection bound to a different tenant cannot vouch for a sale bootstrapped under this tenantScope (cross-tenant fail-closed)", () => {
  const { tenantScope, customer } = baseFixture("victim");
  const otherFixture = baseFixture("attacker");
  const foreignConnection = verifiedConnection(otherFixture.ownership);

  assert.throws(
    () =>
      bootstrapExternalSaleOutcome({
        tenantScope,
        customer,
        connection: foreignConnection,
        externalSaleRef: "order-cross-tenant",
        jobFamily: "WEBSITE_BUILD",
        businessObjective: "Deliver purchased website build",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R4: a REVOKED connection cannot vouch for an external sale fact (fail-closed on non-VERIFIED state)", () => {
  const { tenantScope, customer, ownership } = baseFixture("revoked");
  const verified = verifiedConnection(ownership);
  const revoked = transitionConnectionBinding(verified, "REVOKED");

  assert.throws(
    () =>
      bootstrapExternalSaleOutcome({
        tenantScope,
        customer,
        connection: revoked,
        externalSaleRef: "order-revoked",
        jobFamily: "WEBSITE_BUILD",
        businessObjective: "Deliver purchased website build",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R5: a REQUESTED (never-verified) connection cannot vouch for an external sale fact", () => {
  const { tenantScope, customer, ownership } = baseFixture("requested");
  const requirement = createConnectionRequirement({
    connectionRequirementId: "req-requested-only",
    ownership,
    requiredCapabilityRef: "required-access-connections",
    purpose: "vouch for external sale facts",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH2",
    validationRequirement: "provider-verified",
  });
  const requested = createConnectionBinding({
    connectionBindingId: "bind-requested-only",
    requirement,
    ownership,
    providerRef: "SHOPIFY",
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
  });

  assert.throws(
    () =>
      bootstrapExternalSaleOutcome({
        tenantScope,
        customer,
        connection: requested,
        externalSaleRef: "order-requested-only",
        jobFamily: "WEBSITE_BUILD",
        businessObjective: "Deliver purchased website build",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R6: a customer belonging to a different tenant cannot be used to bootstrap a sale under this tenantScope", () => {
  const { tenantScope, ownership } = baseFixture("tenant-x");
  const connection = verifiedConnection(ownership);
  const foreignCustomer = createCustomer({
    tenantScope: createTenantScope("tenant-y"),
    customerId: "cust-tenant-y",
    displayName: "Foreign Customer",
  });

  assert.throws(
    () =>
      bootstrapExternalSaleOutcome({
        tenantScope,
        customer: foreignCustomer,
        connection,
        externalSaleRef: "order-foreign-customer",
        jobFamily: "WEBSITE_BUILD",
        businessObjective: "Deliver purchased website build",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R7: applyExternalSaleDisposition rejects an unrecognized disposition kind", () => {
  const { tenantScope, customer, ownership } = baseFixture("kind-check");
  const connection = verifiedConnection(ownership);
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    connection,
    externalSaleRef: "order-kind-check",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });

  assert.throws(
    () =>
      applyExternalSaleDisposition({
        job,
        kind: "SOMETHING_ELSE",
        externalSaleRef: "order-kind-check",
        eventId: "evt-1",
        actorRef: "provider:shopify",
        timestamp: "2026-09-01T00:00:00.000Z",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R8: CANCELLATION/REFUND/CHARGEBACK yield an explicit governed STOPPED disposition with an auditable, disposition-specific reason", () => {
  const { tenantScope, customer, ownership } = baseFixture("disposition");
  const connection = verifiedConnection(ownership);
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    connection,
    externalSaleRef: "order-disposition",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });

  for (const kind of ["CANCELLATION", "REFUND", "CHARGEBACK"] as const) {
    const { job: stoppedJob, auditEvent } = applyExternalSaleDisposition({
      job,
      kind,
      externalSaleRef: "order-disposition",
      eventId: `evt-${kind}`,
      actorRef: "provider:shopify",
      timestamp: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(stoppedJob.state, "STOPPED");
    assert.equal(auditEvent.eventType, "EXCEPTION_STATE_ENTERED:STOPPED");
    assert.equal(auditEvent.reason, `${kind} for external sale order-disposition`);
  }
});

test("R9: a job already CLOSED cannot receive a disposition (reuses outcome-job.ts's own exception-entry precondition, not a fabricated exit graph)", () => {
  const { tenantScope, customer, ownership } = baseFixture("closed-guard");
  const connection = verifiedConnection(ownership);
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    connection,
    externalSaleRef: "order-closed-guard",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });

  const readyJob = transitionOutcomeJob(
    transitionOutcomeJob(transitionOutcomeJob(job, "QUALIFIED"), "READY"),
    "EXECUTING",
  );
  const verifyingJob = transitionOutcomeJob(readyJob, "VERIFYING");
  const evidence = createEvidenceReference({
    job: verifyingJob,
    evidenceId: "evidence-closed-guard",
    evidenceType: "DELIVERY_PROOF",
    sourceLocator: "https://example.com/evidence",
    capturedAt: "2026-09-01T00:00:00.000Z",
  });
  const verificationResult = createVerificationResult({
    verificationId: "verification-closed-guard",
    job: verifyingJob,
    evidence,
    verificationRequirementRef: "delivery-verified",
    status: "PASSED",
  });
  const verifiedJob = verifyOutcomeJob(verifyingJob, verificationResult);
  const closedJob = transitionOutcomeJob(verifiedJob, "CLOSED");

  assert.throws(() =>
    applyExternalSaleDisposition({
      job: closedJob,
      kind: "REFUND",
      externalSaleRef: "order-closed-guard",
      eventId: "evt-closed-guard",
      actorRef: "provider:shopify",
      timestamp: "2026-09-01T00:00:00.000Z",
    }),
  );
});

test("R10: the full sale-to-close happy path only reaches CLOSED via a PASSED VerificationResult - execution success alone can never close the job", () => {
  const { tenantScope, customer, ownership } = baseFixture("happy-path");
  const connection = verifiedConnection(ownership);
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    connection,
    externalSaleRef: "order-happy-path",
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });

  const executingJob = transitionOutcomeJob(
    transitionOutcomeJob(transitionOutcomeJob(job, "QUALIFIED"), "READY"),
    "EXECUTING",
  );
  const verifyingJob = transitionOutcomeJob(executingJob, "VERIFYING");

  // T5: execution reaching VERIFYING alone must never be closable directly.
  assert.throws(() => transitionOutcomeJob(verifyingJob, "CLOSED"));

  const evidence = createEvidenceReference({
    job: verifyingJob,
    evidenceId: "evidence-happy-path",
    evidenceType: "DELIVERY_PROOF",
    sourceLocator: "https://example.com/evidence",
    capturedAt: "2026-09-01T00:00:00.000Z",
  });

  const failedVerification = createVerificationResult({
    verificationId: "verification-happy-path-failed",
    job: verifyingJob,
    evidence,
    verificationRequirementRef: "delivery-verified",
    status: "FAILED",
    limitationOrFailureReason: "delivery proof incomplete",
  });
  // A FAILED verification is present evidence, not proof - it cannot close the loop.
  assert.throws(() => verifyOutcomeJob(verifyingJob, failedVerification));

  const passedVerification = createVerificationResult({
    verificationId: "verification-happy-path-passed",
    job: verifyingJob,
    evidence,
    verificationRequirementRef: "delivery-verified",
    status: "PASSED",
  });
  const verifiedJob = verifyOutcomeJob(verifyingJob, passedVerification);
  assert.equal(verifiedJob.state, "VERIFIED");
  const closedJob = transitionOutcomeJob(verifiedJob, "CLOSED");
  assert.equal(closedJob.state, "CLOSED");
});
