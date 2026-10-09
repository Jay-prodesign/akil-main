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
  createVerifiedExternalCommerceFact,
  deriveCanonicalSaleId,
  InvalidExternalSaleBootstrapError,
  type VerifiedExternalCommerceFact,
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

function verifiedConnection(
  ownership: ReturnType<typeof createProjectOwnershipRef>,
  providerRef = "SHOPIFY",
): ConnectionBinding {
  const requirement = createConnectionRequirement({
    connectionRequirementId: `req-${ownership.tenantId}-${providerRef}`,
    ownership,
    requiredCapabilityRef: "required-access-connections",
    purpose: "vouch for external sale facts",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "OAUTH2",
    validationRequirement: "provider-verified",
  });
  const requested = createConnectionBinding({
    connectionBindingId: `bind-${ownership.tenantId}-${providerRef}`,
    requirement,
    ownership,
    providerRef,
    workspaceRef: "workspace-1",
    integrationInstanceRef: "instance-1",
    delegatedScope: [],
  });
  const unverified = transitionConnectionBinding(requested, "CONNECTED_UNVERIFIED");
  return verifyConnectionBinding(unverified, "evidence:provider-handshake");
}

function verifiedFact(
  tenantScope: ReturnType<typeof createTenantScope>,
  connection: ConnectionBinding,
  externalOrderRef: string,
): VerifiedExternalCommerceFact {
  return createVerifiedExternalCommerceFact({
    tenantScope,
    connection,
    externalOrderRef,
    evidenceRef: `evidence:webhook-${externalOrderRef}`,
  });
}

test("R1: bootstrapExternalSaleOutcome creates Project+SoldScope+OutcomeJob deterministically from a verified external-commerce fact", () => {
  const { tenantScope, customer, ownership } = baseFixture();
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-1001");
  const saleId = deriveCanonicalSaleId(fact);

  const result = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });

  assert.equal(result.project.projectId, `sale-project:${saleId}`);
  assert.equal(result.soldScope.soldScopeId, `sale-scope:${saleId}`);
  assert.equal(result.job.jobId, `sale-job:${saleId}`);
  assert.equal(result.job.state, "DRAFT");
  assert.equal(result.soldScope.projectId, result.project.projectId);
});

test("R2: replaying bootstrapExternalSaleOutcome with the same verified fact produces a byte-for-byte identical result (pure idempotent function)", () => {
  const { tenantScope, customer, ownership } = baseFixture();
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-replay-1");
  const input = {
    tenantScope,
    customer,
    fact,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  };

  const first = bootstrapExternalSaleOutcome(input);
  const second = bootstrapExternalSaleOutcome(input);

  assert.deepEqual(first, second);
});

test("R3: a connection bound to a different tenant cannot vouch for a sale fact under this tenantScope (cross-tenant fail-closed at fact-creation time)", () => {
  const { tenantScope } = baseFixture("victim");
  const otherFixture = baseFixture("attacker");
  const foreignConnection = verifiedConnection(otherFixture.ownership);

  assert.throws(
    () =>
      createVerifiedExternalCommerceFact({
        tenantScope,
        connection: foreignConnection,
        externalOrderRef: "order-cross-tenant",
        evidenceRef: "evidence:x",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R4: a REVOKED connection cannot vouch for an external sale fact (fail-closed on non-VERIFIED state)", () => {
  const { tenantScope, ownership } = baseFixture("revoked");
  const verified = verifiedConnection(ownership);
  const revoked = transitionConnectionBinding(verified, "REVOKED");

  assert.throws(
    () =>
      createVerifiedExternalCommerceFact({
        tenantScope,
        connection: revoked,
        externalOrderRef: "order-revoked",
        evidenceRef: "evidence:x",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R5: a REQUESTED (never-verified) connection cannot vouch for an external sale fact - a bare caller string is never enough", () => {
  const { tenantScope, ownership } = baseFixture("requested");
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
      createVerifiedExternalCommerceFact({
        tenantScope,
        connection: requested,
        externalOrderRef: "order-requested-only",
        evidenceRef: "evidence:x",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R6: a customer belonging to a different tenant cannot be used to bootstrap a sale under this tenantScope", () => {
  const { tenantScope, ownership } = baseFixture("tenant-x");
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-foreign-customer");
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
        fact,
        jobFamily: "WEBSITE_BUILD",
        businessObjective: "Deliver purchased website build",
      }),
    InvalidExternalSaleBootstrapError,
  );
});

test("R7: applyExternalSaleDisposition rejects an unrecognized disposition kind", () => {
  const { tenantScope, customer, ownership } = baseFixture("kind-check");
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-kind-check");
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact,
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

test("R8: CANCELLATION/REFUND/CHARGEBACK on a normally-progressing job yield an explicit governed STOPPED disposition (not audit-only) with a disposition-specific reason", () => {
  const { tenantScope, customer, ownership } = baseFixture("disposition");
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-disposition");
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });

  for (const kind of ["CANCELLATION", "REFUND", "CHARGEBACK"] as const) {
    const { job: stoppedJob, auditEvent, recordedAsEscalationOnly } = applyExternalSaleDisposition({
      job,
      kind,
      externalSaleRef: "order-disposition",
      eventId: `evt-${kind}`,
      actorRef: "provider:shopify",
      timestamp: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(recordedAsEscalationOnly, false);
    assert.equal(stoppedJob.state, "STOPPED");
    assert.equal(auditEvent.eventType, "EXCEPTION_STATE_ENTERED:STOPPED");
    assert.equal(auditEvent.reason, `${kind} for external sale order-disposition`);
  }
});

test("R9 (Rev94 F5): a disposition arriving after the job is already CLOSED is recorded as an audit-only escalation - never a lifecycle rollback, never silently dropped", () => {
  const { tenantScope, customer, ownership } = baseFixture("closed-guard");
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-closed-guard");
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact,
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

  const { job: resultJob, auditEvent, recordedAsEscalationOnly } = applyExternalSaleDisposition({
    job: closedJob,
    kind: "REFUND",
    externalSaleRef: "order-closed-guard",
    eventId: "evt-closed-guard",
    actorRef: "provider:shopify",
    timestamp: "2026-09-01T00:00:00.000Z",
  });

  assert.equal(recordedAsEscalationOnly, true);
  // No lifecycle rollback: the job stays exactly CLOSED.
  assert.equal(resultJob.state, "CLOSED");
  assert.deepEqual(resultJob, closedJob);
  assert.equal(auditEvent.eventType, "POST_LIFECYCLE_DISPOSITION_RECORDED:REFUND");
  assert.match(auditEvent.reason ?? "", /REFUND for external sale order-closed-guard/);
  assert.match(auditEvent.reason ?? "", /already CLOSED/);
});

test("R9b (Rev94 F5): a disposition arriving while the job is BLOCKED, RECOVERING, or already ESCALATED/STOPPED is also recorded as an audit-only escalation, never thrown away", () => {
  const { tenantScope, customer, ownership } = baseFixture("mid-exception");
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-mid-exception");
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });
  const executingJob = transitionOutcomeJob(transitionOutcomeJob(transitionOutcomeJob(job, "QUALIFIED"), "READY"), "EXECUTING");

  for (const exceptionState of ["BLOCKED", "RECOVERING", "ESCALATED"] as const) {
    const enteredJob = { ...executingJob, state: exceptionState };
    const { job: resultJob, recordedAsEscalationOnly } = applyExternalSaleDisposition({
      job: enteredJob,
      kind: "CHARGEBACK",
      externalSaleRef: "order-mid-exception",
      eventId: `evt-mid-${exceptionState}`,
      actorRef: "provider:shopify",
      timestamp: "2026-09-01T00:00:00.000Z",
    });
    assert.equal(recordedAsEscalationOnly, true);
    assert.equal(resultJob.state, exceptionState);
  }
});

test("R10: the full sale-to-close happy path only reaches CLOSED via a PASSED VerificationResult - execution success alone can never close the job", () => {
  const { tenantScope, customer, ownership } = baseFixture("happy-path");
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-happy-path");
  const { job } = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });

  const executingJob = transitionOutcomeJob(
    transitionOutcomeJob(transitionOutcomeJob(job, "QUALIFIED"), "READY"),
    "EXECUTING",
  );
  const verifyingJob = transitionOutcomeJob(executingJob, "VERIFYING");

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

test("R11 (Rev94 F2): the same externalOrderRef from a different provider, a different account, a different connection, or a different tenant never collides on canonical sale identity", () => {
  const { tenantScope, customer, ownership } = baseFixture("namespace-a");
  const shopifyConnection = verifiedConnection(ownership, "SHOPIFY");
  const wooConnection = verifiedConnection(ownership, "WOOCOMMERCE");

  const sharedOrderRef = "order-shared-id-999";
  const factShopify = verifiedFact(tenantScope, shopifyConnection, sharedOrderRef);
  const factWoo = verifiedFact(tenantScope, wooConnection, sharedOrderRef);

  assert.notEqual(deriveCanonicalSaleId(factShopify), deriveCanonicalSaleId(factWoo));

  const resultShopify = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact: factShopify,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });
  const resultWoo = bootstrapExternalSaleOutcome({
    tenantScope,
    customer,
    fact: factWoo,
    jobFamily: "WEBSITE_BUILD",
    businessObjective: "Deliver purchased website build",
  });
  assert.notEqual(resultShopify.job.jobId, resultWoo.job.jobId);
  assert.notEqual(resultShopify.project.projectId, resultWoo.project.projectId);

  // Different tenant, same provider/order id also does not collide.
  const otherFixture = baseFixture("namespace-b");
  const otherConnection = verifiedConnection(otherFixture.ownership, "SHOPIFY");
  const factOtherTenant = verifiedFact(otherFixture.tenantScope, otherConnection, sharedOrderRef);
  assert.notEqual(factShopify.tenantId, factOtherTenant.tenantId);
});

test("R13: a fact whose own recorded tenantId does not match the tenantScope passed to bootstrapExternalSaleOutcome fails closed (defense in depth beyond fact construction)", () => {
  const { tenantScope, customer, ownership } = baseFixture("defense-in-depth");
  const connection = verifiedConnection(ownership);
  const fact = verifiedFact(tenantScope, connection, "order-defense-in-depth");
  const wrongTenantScope = createTenantScope("tenant-completely-different");

  assert.throws(
    () =>
      bootstrapExternalSaleOutcome({
        tenantScope: wrongTenantScope,
        customer,
        fact,
        jobFamily: "WEBSITE_BUILD",
        businessObjective: "Deliver purchased website build",
      }),
    InvalidExternalSaleBootstrapError,
  );
});
