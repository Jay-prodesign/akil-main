import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createAuthorityContext } from "../src/domain/authority.js";

import {
  createQuotaAdmissionScope,
  createQuotaEnvelope,
  createQuotaReservationIdentity,
  admitQuotaReservation,
  EMPTY_QUOTA_LEDGER,
  type QuotaEnvelope,
} from "../src/domain/execution-quota-admission.js";
import { FileDurableQuotaReservationStore } from "../src/domain/durable-quota-reservation-store.js";

import { createOutcomeJob } from "../src/domain/outcome-job.js";
import type { WorkerInvoker } from "../src/domain/worker-invoker.js";
import { FileDurableOutcomeJobExecutionStore } from "../src/domain/durable-outcome-job-execution-store.js";
import {
  dispatchOutcomeJobExecutionRun,
  type ExecutionEconomicsPort,
  type CurrentQuotaEnvelopeResolver,
} from "../src/application/outcome-job-execution-runtime.js";
import {
  appendExecutionEconomicsEventAllowingCapturedAtDrift,
  EMPTY_EXECUTION_ECONOMICS_LEDGER,
  type ExecutionEconomicsEvent,
  type ExecutionEconomicsLedger,
} from "../src/domain/execution-economics-attribution.js";

import { createConnectionRequirement, createConnectionBinding, createSecretRef } from "../src/domain/connection-authority.js";
import { transitionConnectorConnection, verifyConnectorConnection, type ConnectorConnectionInstance } from "../src/domain/integration-connector-catalog.js";
import { FileDurableConnectorConnectionStore } from "../src/domain/durable-connector-connection-store.js";
import { createGenericApiConnectorDefinition } from "../src/domain/generic-connector-definition.js";
import {
  executeConnectorCapability,
  UnresolvedConnectorSecretError,
  type SecretResolver,
  type ConnectorTransport,
  type ConnectorTransportRequest,
} from "../src/domain/connector-execution.js";

type BoundConnectorDefinition = Parameters<typeof executeConnectorCapability>[0]["bound"];

/**
 * OS-V0-15 "V0 Adversarial & Chaos Gate" (Brain Rev197): three genuinely NEW
 * deterministic fault-injection witnesses for the three matrix items (#11
 * retry-storm, #13 secret-exfiltration, #17 crash-loop) that existing
 * OS-V0-05/07/09/10/13/14 evidence does not already cover verbatim. Every
 * other activated matrix item is cited to existing evidence in
 * docs/exec-plans/active/OS-V0-15.md rather than re-proven here, per Rev197's
 * own "reuse accepted evidence where semantics are unchanged" instruction.
 * Zero new production source files - this file composes exclusively
 * already-accepted OS-V0-05/07/10 exports.
 */

const TENANT_SCOPE = createTenantScope("t-chaos");
const CUSTOMER = createCustomer({ tenantScope: TENANT_SCOPE, customerId: "c-chaos", displayName: "OS-V0-15 Chaos Probe" });
const PROJECT = createProject({ tenantScope: TENANT_SCOPE, customer: CUSTOMER, projectId: "p-chaos", ownerRef: "chaos-owner", state: "active" });
const OWNERSHIP = createProjectOwnershipRef({ tenantId: TENANT_SCOPE.tenantId, customerId: CUSTOMER.customerId, projectId: PROJECT.projectId });
const AUTHORITY = createAuthorityContext({ tenantScope: TENANT_SCOPE, permissions: ["EXECUTE", "WRITE", "READ"], canPerformProtectedActions: true });

function jsonlLineCount(dir: string): number {
  return readdirSync(dir).reduce((total, file) => {
    const content = readFileSync(join(dir, file), "utf8");
    return total + content.split("\n").filter((line) => line.trim().length > 0).length;
  }, 0);
}

// --- #11: cost fan-out / retry-storm pressure against an exhausted quota envelope ---

test("OS-V0-15 (#11 retry-storm): repeated admission retries against an exhausted quota envelope, using the SAME idempotencyKey, fail closed deterministically with ZERO further durable ledger growth across the storm and across a restart", () => {
  const quotaDir = mkdtempSync(join(tmpdir(), "os-v0-15-retry-storm-quota-"));
  const store = new FileDurableQuotaReservationStore(quotaDir);
  const scope = createQuotaAdmissionScope({ tenantScope: TENANT_SCOPE, customerId: CUSTOMER.customerId, projectId: PROJECT.projectId, planId: "plan-chaos", planVersion: 1 });
  const envelope: QuotaEnvelope = createQuotaEnvelope({ scope, envelopeRef: "envelope-chaos", sourceFingerprint: "qfp-chaos", unitLimit: 1 });

  // The occupant consumes the entire unit floor, leaving zero allowance for
  // the storm caller below - this is the "exhausted envelope" precondition
  // a cost fan-out / retry-storm would hammer against.
  const occupant = store.admit({
    envelope,
    identity: createQuotaReservationIdentity({ scope, jobId: "job-occupant", runId: "run-occupant", attemptRef: "1" }),
    idempotencyKey: "key-occupant",
    requestedAmount: { presence: "UNKNOWN" },
    occurredAt: "2026-10-07T00:00:00.000Z",
  });
  assert.equal(occupant.status, "RESERVED");

  const stormIdentity = createQuotaReservationIdentity({ scope, jobId: "job-storm", runId: "run-storm", attemptRef: "1" });
  const stormRequest = {
    envelope,
    identity: stormIdentity,
    idempotencyKey: "key-storm",
    requestedAmount: { presence: "UNKNOWN" as const },
    occurredAt: "2026-10-07T00:00:01.000Z",
  };

  const firstRejection = store.admit(stormRequest);
  assert.equal(firstRejection.status, "REJECTED");
  const lineCountAfterFirst = jsonlLineCount(quotaDir);
  assert.equal(lineCountAfterFirst, 2, "exactly one RESERVED (occupant) + one REJECTED (storm) line - no more");

  // The storm: 25 further repeated retries of the IDENTICAL idempotencyKey,
  // simulating cost fan-out / retry-storm pressure against the still-
  // exhausted envelope.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const retry = store.admit({ ...stormRequest, occurredAt: `2026-10-07T00:00:${String(2 + attempt).padStart(2, "0")}.000Z` });
    assert.equal(retry.status, "REJECTED", `retry ${attempt} must stay REJECTED - an exhausted envelope is never eventually admitted by sheer repetition`);
    assert.equal(retry.event.eventId, firstRejection.event.eventId, `retry ${attempt} must replay the IDENTICAL cached rejection event, never append a new one`);
  }
  assert.equal(jsonlLineCount(quotaDir), 2, "25 further repeated retries against the same exhausted envelope caused ZERO additional ledger growth");

  // Restart: a fresh store instance at the SAME durable directory still
  // deterministically replays the identical cached REJECTED truth - the
  // exact next allowed action (wait for allowance to free up, never "keep
  // retrying harder") survives a crash/restart mid-storm.
  const restartedStore = new FileDurableQuotaReservationStore(quotaDir);
  const afterRestart = restartedStore.admit(stormRequest);
  assert.equal(afterRestart.status, "REJECTED");
  assert.equal(afterRestart.event.eventId, firstRejection.event.eventId);
  assert.equal(jsonlLineCount(quotaDir), 2);
});

// --- #13: secret-exfiltration resistance in executeConnectorCapability ---

function buildChaosConnectionInstance(secretRefId: string): ConnectorConnectionInstance {
  const requirement = createConnectionRequirement({
    connectionRequirementId: "creq-chaos",
    ownership: OWNERSHIP,
    requiredCapabilityRef: "cap-chaos-generic-read",
    purpose: "OS-V0-15 secret-exfiltration probe",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: ["read:files"],
    connectionMethod: "OAUTH2",
    validationRequirement: "verified-oauth-handshake",
  });
  const binding = createConnectionBinding({
    connectionBindingId: "conn-chaos-exfil-probe",
    requirement,
    ownership: OWNERSHIP,
    providerRef: "GENERIC_CUSTOM_API",
    workspaceRef: "workspace-chaos",
    integrationInstanceRef: "integration-chaos",
    delegatedScope: ["read:files"],
    secretRef: createSecretRef({ secretRefId }),
  });
  return { binding, connectorKind: "GENERIC_CUSTOM_API", authMode: "API_KEY" };
}

function buildChaosConnectorBound(instance: ConnectorConnectionInstance): BoundConnectorDefinition {
  const definition = createGenericApiConnectorDefinition({
    connectionBindingId: instance.binding.connectionBindingId,
    baseUrl: "https://internal-chaos.akilta.test",
    authMode: "API_KEY",
    endpoints: [{ capabilityRef: "cap-chaos-generic-read", method: "GET", path: "/files" }],
  });
  return { instance, definition };
}

test("OS-V0-15 (#13 secret-exfiltration): executeConnectorCapability never surfaces a resolved secret value in a thrown error message or in its own successful return value - only the opaque secretRef id ever appears", () => {
  const REAL_SECRET = "sk-live-top-secret-should-never-leak-9f3a21";
  const connDir = mkdtempSync(join(tmpdir(), "os-v0-15-exfil-conn-"));
  const connectionStore = new FileDurableConnectorConnectionStore(connDir);

  let instance = buildChaosConnectionInstance("secret-ref-chaos-exfil-probe");
  let stored = connectionStore.save(instance);
  instance = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
  stored = connectionStore.save(instance, stored.version);
  instance = verifyConnectorConnection(instance, "evidence://os-v0-15/chaos-exfil-verified-1");
  stored = connectionStore.save(instance, stored.version);
  assert.equal(stored.instance.binding.connectionState, "VERIFIED");

  const bound = buildChaosConnectorBound(stored.instance);
  const neverCalledTransport: ConnectorTransport = {
    execute: () => {
      throw new Error("transport must never be invoked once secret resolution itself has already failed");
    },
  };

  // Case 1: the resolver throws. The thrown error must cite only the opaque
  // secretRefId, never a resolved value (there is none here, but the
  // exfiltration-resistance property is that the message NEVER echoes
  // resolver internals/exceptions verbatim with a real secret inside).
  const throwingResolver: SecretResolver = { resolve: () => { throw new Error(`leaked-if-buggy:${REAL_SECRET}`); } };
  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap-chaos-generic-read",
        requestingOwnership: OWNERSHIP,
        connectionStore,
        secretResolver: throwingResolver,
        transport: neverCalledTransport,
      }),
    (error: unknown) => {
      assert.ok(error instanceof UnresolvedConnectorSecretError);
      const message = (error as Error).message;
      assert.ok(message.includes("secret-ref-chaos-exfil-probe"), "message must cite the opaque secretRef id");
      assert.ok(!message.includes(REAL_SECRET), "message must never echo the real secret value, even when the resolver's own exception text contains it");
      return true;
    },
  );

  // Case 2: the resolver returns an empty value. Same opaque-id-only
  // message contract; no secret value exists to leak, but the error path
  // is independently exercised.
  const emptyResolver: SecretResolver = { resolve: () => "" };
  assert.throws(
    () =>
      executeConnectorCapability({
        bound,
        capabilityRef: "cap-chaos-generic-read",
        requestingOwnership: OWNERSHIP,
        connectionStore,
        secretResolver: emptyResolver,
        transport: neverCalledTransport,
      }),
    (error: unknown) => {
      assert.ok(error instanceof UnresolvedConnectorSecretError);
      assert.ok((error as Error).message.includes("secret-ref-chaos-exfil-probe"));
      return true;
    },
  );

  // Case 3: the resolver succeeds and genuinely returns the real secret -
  // the transport boundary (an already-admitted, caller-injected port) is
  // the ONE place authSecretValue is intentionally handed over; the
  // function's OWN successful return value must never itself carry it,
  // regardless of what the transport does with it.
  let capturedRequest: ConnectorTransportRequest | undefined;
  const capturingTransport: ConnectorTransport = {
    execute: (request) => {
      capturedRequest = request;
      return { outcome: "SUCCESS", data: { ok: true } };
    },
  };
  const result = executeConnectorCapability({
    bound,
    capabilityRef: "cap-chaos-generic-read",
    requestingOwnership: OWNERSHIP,
    connectionStore,
    secretResolver: { resolve: () => REAL_SECRET },
    transport: capturingTransport,
  });
  assert.equal(capturedRequest?.authSecretValue, REAL_SECRET, "the injected transport boundary IS the one place authSecretValue is intentionally handed over");
  assert.ok(!("authSecretValue" in result), "the function's own ConnectorExecutionResult must never itself carry the resolved secret as a field");
  assert.ok(!JSON.stringify(result).includes(REAL_SECRET), "the function's own serialized return value must never contain the real secret value under any outcome");
});

// --- #17: crash-loop / repeated-startup failure (2+ consecutive restart cycles) ---

function acceptingInvoker(callLog: unknown[]): WorkerInvoker {
  return {
    role: "CLAUDE_PRIMARY_ENGINEER",
    invoke: async (input) => {
      callLog.push(input.outcomeJobExecution);
      return { accepted: true };
    },
  };
}

class InMemoryExecutionEconomicsStore implements ExecutionEconomicsPort {
  private ledger: ExecutionEconomicsLedger = EMPTY_EXECUTION_ECONOMICS_LEDGER;
  recordSettledAttempt(event: ExecutionEconomicsEvent): void {
    this.ledger = appendExecutionEconomicsEventAllowingCapturedAtDrift(this.ledger, event);
  }
}

test("OS-V0-15 (#17 crash-loop): a worker that crashes and restarts THREE consecutive times, each time naively re-issuing the identical dispatch call, never double-invokes and never double-reserves quota - durable canonical truth and the exact next-allowed-action (idempotent no-op) stay identical across the entire crash loop, not just a single restart", async () => {
  const job = createOutcomeJob({
    tenantScope: TENANT_SCOPE,
    customer: CUSTOMER,
    project: PROJECT,
    jobId: "job-crash-loop",
    jobFamily: "req-chaos",
    businessObjective: "OS-V0-15 crash-loop containment probe",
  });
  const quotaScope = createQuotaAdmissionScope({ tenantScope: TENANT_SCOPE, customerId: CUSTOMER.customerId, projectId: PROJECT.projectId, planId: "plan-crash-loop", planVersion: 1 });
  const quotaEnvelope: QuotaEnvelope = createQuotaEnvelope({ scope: quotaScope, envelopeRef: "envelope-crash-loop", sourceFingerprint: "qfp-crash-loop", unitLimit: 1_000_000 });
  const quotaEnvelopeResolver: CurrentQuotaEnvelopeResolver = { resolveCurrentQuotaEnvelope: () => quotaEnvelope };

  const execDir = mkdtempSync(join(tmpdir(), "os-v0-15-crash-loop-exec-"));
  const quotaDir = mkdtempSync(join(tmpdir(), "os-v0-15-crash-loop-quota-"));
  const callLog: unknown[] = [];
  const invoker = acceptingInvoker(callLog);

  async function dispatchCycle(eventStore: FileDurableOutcomeJobExecutionStore, quotaStore: FileDurableQuotaReservationStore) {
    const economicsPort = new InMemoryExecutionEconomicsStore();
    return dispatchOutcomeJobExecutionRun({
      tenantScope: TENANT_SCOPE,
      customer: CUSTOMER,
      project: PROJECT,
      job,
      authority: AUTHORITY,
      runId: "run-crash-loop",
      correlationId: "corr-crash-loop",
      now: "2026-10-07T00:00:03.000Z",
      executorKind: "INJECTED",
      expectedFingerprint: "fp-crash-loop",
      currentFingerprint: "fp-crash-loop",
      currentActivationPlanId: "plan-crash-loop",
      currentActivationPlanVersion: 1,
      economicsPort,
      economicsTaskRef: "task-ref-crash-loop",
      economicsUsageSource: "OTHER_ADMITTED",
      taskId: "task-crash-loop",
      branch: "claude/os-v0-15-v0-adversarial-chaos-gate",
      checkpointSha: "sha-crash-loop",
      quotaAdmission: quotaStore,
      quotaEnvelope,
      currentQuotaSourceFingerprint: "qfp-crash-loop",
      quotaEnvelopeResolver,
      estimatedCost: { presence: "REPORTED", amountMinorUnits: 10, currency: "USD" },
      store: eventStore,
      invoker,
    });
  }

  // Cycle 0: the worker's first, genuine dispatch.
  const cycle0Store = new FileDurableOutcomeJobExecutionStore(execDir);
  const cycle0Quota = new FileDurableQuotaReservationStore(quotaDir);
  const cycle0 = await dispatchCycle(cycle0Store, cycle0Quota);
  assert.equal(cycle0.invoked, true, "cycle 0 is the genuine first dispatch - the worker IS invoked");
  assert.equal(callLog.length, 1);
  const quotaLinesAfterCycle0 = jsonlLineCount(quotaDir);
  assert.equal(quotaLinesAfterCycle0, 2, "exactly one RESERVED + one COMMITTED quota line (OTHER_ADMITTED usage settles immediately) after the genuine first dispatch - never more");

  // Simulate a crash-LOOP: the worker process dies and restarts THREE
  // separate times before this test ends, and each time it naively
  // re-issues the IDENTICAL dispatch call (same job/runId/correlationId)
  // against a FRESH store instance pointed at the SAME durable directories -
  // exactly what a real crash-looping worker process would do on every
  // restart attempt, not just once.
  for (let restartCycle = 1; restartCycle <= 3; restartCycle += 1) {
    const restartedEventStore = new FileDurableOutcomeJobExecutionStore(execDir);
    const restartedQuotaStore = new FileDurableQuotaReservationStore(quotaDir);
    const restarted = await dispatchCycle(restartedEventStore, restartedQuotaStore);
    assert.equal(restarted.invoked, false, `crash-loop restart cycle ${restartCycle} must be a pure idempotent no-op - the worker must never be re-invoked`);
    assert.deepEqual(restarted.state, cycle0.state, `crash-loop restart cycle ${restartCycle} must reconstruct the EXACT same durable canonical truth as the genuine first dispatch`);
    assert.equal(callLog.length, 1, `crash-loop restart cycle ${restartCycle} must never cause a second real worker invocation`);
    assert.equal(jsonlLineCount(quotaDir), quotaLinesAfterCycle0, `crash-loop restart cycle ${restartCycle} must cause ZERO further quota ledger growth`);
  }
});
