import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import {
  createQuotaAdmissionScope,
  createQuotaReservationIdentity,
  createQuotaEnvelope,
} from "../src/domain/execution-quota-admission.js";
import { FileDurableQuotaReservationStore } from "../src/domain/durable-quota-reservation-store.js";
import {
  resolveAndProjectConfigurationPolicyDecision,
  rollbackConfigurationPolicyDecision,
} from "../src/domain/resolve-and-project-configuration-policy-decision.js";
import { FileDurableConfigurationPolicyDecisionStore } from "../src/domain/durable-configuration-policy-decision-store.js";
import { createAuthorityContext, type AuthorityContext } from "../src/domain/authority.js";

/**
 * OS-V1-11 (Integrated Release Candidate): AA-005 REV209's own text requires
 * "one exact candidate runs Organization Zero and MULTIPLE controlled
 * organizations concurrently." A repository-wide inspection before this
 * task found every prior concurrent cross-org witness was exactly TWO
 * organizations at a time - Organization Zero + Organization B (OS-V0-14),
 * or Controlled A + Controlled B (OS-V1-10's own `CHAOS1`). Neither ever
 * ran Organization Zero alongside TWO controlled organizations together.
 * This is that genuinely missing three-way composition - a direct
 * extension of OS-V1-10's own `CHAOS1` shape (concurrent quota fan-out
 * races + config rollbacks on shared store instances) from two
 * organizations to three, reusing exclusively already-accepted OS-V0-07/
 * V0-11/V1-08 primitives. Zero new production code.
 */

interface OrgFixture {
  readonly label: string;
  readonly tenantScope: TenantScope;
  readonly authority: AuthorityContext;
  readonly ceiling: number;
  readonly fanOutCount: number;
}

function orgFixture(label: string, ceiling: number, fanOutCount: number): OrgFixture {
  const tenantScope = createTenantScope(`tenant-os-v1-11-${label.toLowerCase()}`);
  const authority = createAuthorityContext({ tenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true });
  return { label, tenantScope, authority, ceiling, fanOutCount };
}

test("THREEWAY1 (NEW, genuine V1-11 composition gap): Organization Zero + Controlled A + Controlled B, THREE organizations, ONE concurrent Promise.all - quota races and config rollbacks on shared stores, zero cross-company leakage among all three", async () => {
  const orgs: ReadonlyArray<OrgFixture> = [
    orgFixture("ZERO", 4, 6),
    orgFixture("A", 3, 5),
    orgFixture("B", 2, 4),
  ];

  const quotaDir = mkdtempSync(join(tmpdir(), "os-v1-11-quota-"));
  const configDir = mkdtempSync(join(tmpdir(), "os-v1-11-config-"));
  try {
    const quotaStore = new FileDurableQuotaReservationStore(quotaDir);
    const configStore = new FileDurableConfigurationPolicyDecisionStore(configDir);

    const quotaOps: Array<Promise<{ label: string; status: string }>> = [];
    const rollbackOps: Array<Promise<{ label: string; kind: string; decisionKey: string }>> = [];

    for (const org of orgs) {
      const scope = createQuotaAdmissionScope({ tenantScope: org.tenantScope, customerId: "cust-threeway", projectId: "proj-threeway", planId: "plan-1", planVersion: 1 });
      const envelope = createQuotaEnvelope({ scope, envelopeRef: `env-threeway-${org.label}`, sourceFingerprint: "fp-1", unitLimit: org.ceiling });
      for (let i = 0; i < org.fanOutCount; i++) {
        const identity = createQuotaReservationIdentity({ scope, jobId: "job-threeway", runId: `run-${org.label}-${i}`, attemptRef: "1" });
        quotaOps.push(
          Promise.resolve(
            quotaStore.admit({
              envelope,
              identity,
              idempotencyKey: `threeway-${org.label}-${i}`,
              requestedAmount: { presence: "UNKNOWN" },
              occurredAt: "2026-10-09T00:00:00.000Z",
            }),
          ).then((outcome) => ({ label: org.label, status: outcome.status })),
        );
      }

      const configIdentity = { tenantId: org.tenantScope.tenantId, jobId: "job-shared-threeway" };
      const platformControl = (overrides: Record<string, unknown> = {}) => ({
        kind: "CONFIG", scope: "PLATFORM", key: "theme", sourceRef: "theme-default", version: "1", identity: {}, ...overrides,
      });
      const seed = resolveAndProjectConfigurationPolicyDecision({
        store: configStore, identity: configIdentity, controls: [platformControl()], decisionId: `${org.label}-d1`, now: "2026-10-09T00:00:00.000Z",
      });
      resolveAndProjectConfigurationPolicyDecision({
        store: configStore, identity: configIdentity, controls: [platformControl({ sourceRef: "theme-dark", version: "2" })],
        decisionId: `${org.label}-d2`, now: "2026-10-09T00:01:00.000Z",
      });
      const decisionKey = seed.entry.decisionKey;
      rollbackOps.push(
        Promise.resolve(
          rollbackConfigurationPolicyDecision({
            store: configStore, identity: configIdentity, authority: org.authority, rollbackToDecisionId: `${org.label}-d1`,
            currentControls: [platformControl({ sourceRef: "theme-dark", version: "2" })], decisionId: `${org.label}-d3`, now: "2026-10-09T00:02:00.000Z",
          }),
        ).then((result) => ({ label: org.label, kind: result.kind, decisionKey })),
      );
    }

    const [quotaResults, rollbackResults] = await Promise.all([Promise.all(quotaOps), Promise.all(rollbackOps)]);

    for (const org of orgs) {
      const reserved = quotaResults.filter((r) => r.label === org.label && r.status === "RESERVED").length;
      assert.equal(reserved, org.ceiling, `${org.label}'s own ceiling (${org.ceiling}) must be respected exactly under three-way concurrent load`);
    }

    for (const org of orgs) {
      const rollback = rollbackResults.find((r) => r.label === org.label);
      assert.ok(rollback !== undefined);
      assert.equal(rollback.kind, "ROLLED_BACK");
      const history = configStore.getDecisionProjectionHistory(org.tenantScope.tenantId, rollback.decisionKey);
      assert.equal(history.length, 3, `${org.label}'s own config history must be unaffected by the other two organizations' concurrent rollback on a colliding bare jobId`);
      assert.equal(history[2]?.rolledBackToDecisionId, `${org.label}-d1`);
    }
  } finally {
    rmSync(quotaDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});
