import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createAuthorityContext, CrossTenantAuthorityError, InsufficientAuthorityError, ProtectedActionNotAuthorizedError } from "../src/domain/authority.js";
import { FileDurableConfigurationPolicyDecisionStore } from "../src/domain/durable-configuration-policy-decision-store.js";
import {
  ConfigurationPolicyDecisionNotFoundError,
  resolveAndProjectConfigurationPolicyDecision,
  rollbackConfigurationPolicyDecision,
} from "../src/domain/resolve-and-project-configuration-policy-decision.js";

const tenantScope = createTenantScope("tenant-os-v0-11-orchestration");

function freshStore(): FileDurableConfigurationPolicyDecisionStore {
  return new FileDurableConfigurationPolicyDecisionStore(mkdtempSync(join(tmpdir(), "os-v0-11-orchestration-")));
}

function platformControl(overrides: Record<string, unknown> = {}) {
  return {
    kind: "CONFIG",
    scope: "PLATFORM",
    key: "theme",
    sourceRef: "platform-theme-default",
    version: "1",
    identity: {},
    ...overrides,
  };
}

function protectedAuthority(overrides: { permissions?: ReadonlyArray<"READ" | "WRITE" | "EXECUTE">; canPerformProtectedActions?: boolean } = {}) {
  return createAuthorityContext({
    tenantScope,
    permissions: overrides.permissions ?? ["EXECUTE"],
    canPerformProtectedActions: overrides.canPerformProtectedActions ?? true,
  });
}

test("O1: the first resolve for an identity appends a new COMPUTED entry, reports stale:false (no prior decision existed), and the drift explains every newly-established control", () => {
  const store = freshStore();
  const result = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity: { tenantId: tenantScope.tenantId },
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(result.stale, false);
  assert.equal(result.entry.entryKind, "COMPUTED");
  assert.equal(result.drift.length, 1);
  assert.equal(result.drift[0]?.previousControl, undefined);
  assert.deepEqual(result.resolution.effectiveConfigRefs, [JSON.stringify(["theme", "1", "platform-theme-default"])]);
});

test("O2: a second resolve with IDENTICAL controls is an idempotent no-op - no new entry appended, stale:false, empty drift", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  resolveAndProjectConfigurationPolicyDecision({ store, identity, controls: [platformControl()], decisionId: "decision-1", now: "2026-10-06T00:00:00.000Z" });
  const second = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl()],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  });
  assert.equal(second.stale, false);
  assert.deepEqual(second.drift, []);
  assert.equal(second.entry.decisionId, "decision-1", "no new entry should have been appended for an unchanged resolution");
});

test("O3: a resolve with a MATERIALLY DIFFERENT control appends a new entry, reports stale:true, and the drift names exactly the changed key", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  resolveAndProjectConfigurationPolicyDecision({ store, identity, controls: [platformControl()], decisionId: "decision-1", now: "2026-10-06T00:00:00.000Z" });
  const third = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  });
  assert.equal(third.stale, true);
  assert.equal(third.entry.decisionId, "decision-2");
  assert.equal(third.drift.length, 1);
  assert.equal(third.drift[0]?.key, "theme");
  assert.equal(third.drift[0]?.previousControl?.sourceRef, "platform-theme-default");
  assert.equal(third.drift[0]?.freshControl?.sourceRef, "platform-theme-dark");
});

test("O4: rollbackConfigurationPolicyDecision appends a NEW entry copying the target's resolution/inputControlsSnapshot, never mutating the existing history", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  const first = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  });

  const rollbackResult = rollbackConfigurationPolicyDecision({
    store,
    identity,
    authority: protectedAuthority(),
    rollbackToDecisionId: "decision-1",
    currentControls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-3",
    now: "2026-10-06T00:02:00.000Z",
  });

  assert.equal(rollbackResult.kind, "ROLLED_BACK");
  assert.ok(rollbackResult.kind === "ROLLED_BACK");
  const rolledBack = rollbackResult.entry;
  assert.equal(rolledBack.entryKind, "ROLLBACK");
  assert.equal(rolledBack.rolledBackToDecisionId, "decision-1");
  assert.deepEqual(rolledBack.resolution, first.resolution);

  const history = store.getDecisionProjectionHistory(tenantScope.tenantId, first.entry.decisionKey);
  assert.equal(history.length, 3, "rollback must append, never remove or mutate prior history");
  assert.equal(history[0]?.decisionId, "decision-1");
  assert.equal(history[1]?.decisionId, "decision-2");
  assert.equal(history[2]?.decisionId, "decision-3");

  const active = store.getActiveDecisionProjection(tenantScope.tenantId, first.entry.decisionKey);
  assert.deepEqual(active, rolledBack);
});

test("O5: rollbackConfigurationPolicyDecision rejects an authority lacking EXECUTE permission - zero mutation", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  const first = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  assert.throws(
    () =>
      rollbackConfigurationPolicyDecision({
        store,
        identity,
        authority: protectedAuthority({ permissions: ["READ"] }),
        rollbackToDecisionId: "decision-1",
        currentControls: [platformControl()],
        decisionId: "decision-2",
        now: "2026-10-06T00:01:00.000Z",
      }),
    InsufficientAuthorityError,
  );
  assert.equal(store.getDecisionProjectionHistory(tenantScope.tenantId, first.entry.decisionKey).length, 1);
});

test("O6: rollbackConfigurationPolicyDecision rejects an authority with EXECUTE but canPerformProtectedActions:false - zero mutation", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  resolveAndProjectConfigurationPolicyDecision({ store, identity, controls: [platformControl()], decisionId: "decision-1", now: "2026-10-06T00:00:00.000Z" });
  assert.throws(
    () =>
      rollbackConfigurationPolicyDecision({
        store,
        identity,
        authority: protectedAuthority({ canPerformProtectedActions: false }),
        rollbackToDecisionId: "decision-1",
        currentControls: [platformControl()],
        decisionId: "decision-2",
        now: "2026-10-06T00:01:00.000Z",
      }),
    ProtectedActionNotAuthorizedError,
  );
});

test("O7: rollbackConfigurationPolicyDecision rejects a cross-tenant authority - zero mutation", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  resolveAndProjectConfigurationPolicyDecision({ store, identity, controls: [platformControl()], decisionId: "decision-1", now: "2026-10-06T00:00:00.000Z" });
  const foreignTenantScope = createTenantScope("tenant-os-v0-11-foreign");
  assert.throws(
    () =>
      rollbackConfigurationPolicyDecision({
        store,
        identity,
        authority: createAuthorityContext({ tenantScope: foreignTenantScope, permissions: ["EXECUTE"], canPerformProtectedActions: true }),
        rollbackToDecisionId: "decision-1",
        currentControls: [platformControl()],
        decisionId: "decision-2",
        now: "2026-10-06T00:01:00.000Z",
      }),
    CrossTenantAuthorityError,
  );
});

test("O8: rollbackConfigurationPolicyDecision targeting a decisionId that was never recorded throws ConfigurationPolicyDecisionNotFoundError", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  resolveAndProjectConfigurationPolicyDecision({ store, identity, controls: [platformControl()], decisionId: "decision-1", now: "2026-10-06T00:00:00.000Z" });
  assert.throws(
    () =>
      rollbackConfigurationPolicyDecision({
        store,
        identity,
        authority: protectedAuthority(),
        rollbackToDecisionId: "decision-never-existed",
        currentControls: [platformControl()],
        decisionId: "decision-2",
        now: "2026-10-06T00:01:00.000Z",
      }),
    ConfigurationPolicyDecisionNotFoundError,
  );
});

test("O9: distinct identities (different jobId) within the same tenant maintain independent decision histories", () => {
  const store = freshStore();
  const jobA = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity: { tenantId: tenantScope.tenantId, jobId: "job-a" },
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  const jobB = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity: { tenantId: tenantScope.tenantId, jobId: "job-b" },
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  assert.notEqual(jobA.entry.decisionKey, jobB.entry.decisionKey);
  assert.notDeepEqual(jobA.resolution, jobB.resolution);
});

test("Rev193 adversarial: a newer PLATFORM protected-floor control established after the target decision blocks the historical rollback - zero mutation, active entry unchanged", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-default", version: "1" })],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  const second = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  });

  const result = rollbackConfigurationPolicyDecision({
    store,
    identity,
    authority: protectedAuthority(),
    rollbackToDecisionId: "decision-1",
    // A PLATFORM protectedFloor control for "theme" was established AFTER
    // decision-1 was originally computed - decision-1's own selection
    // ("platform-theme-default") can never be legitimately resurrected now.
    currentControls: [platformControl({ sourceRef: "platform-theme-protected", version: "3", protectedFloor: true })],
    decisionId: "decision-3",
    now: "2026-10-06T00:02:00.000Z",
  });

  assert.equal(result.kind, "BLOCKED_PROTECTED_FLOOR_CONFLICT");
  assert.ok(result.kind === "BLOCKED_PROTECTED_FLOOR_CONFLICT");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.key, "theme");
  assert.equal(result.conflicts[0]?.freshControl?.sourceRef, "platform-theme-protected");

  const history = store.getDecisionProjectionHistory(tenantScope.tenantId, second.entry.decisionKey);
  assert.equal(history.length, 2, "a blocked rollback must append nothing");
  const active = store.getActiveDecisionProjection(tenantScope.tenantId, second.entry.decisionKey);
  assert.deepEqual(active, second.entry, "the active entry must remain exactly what it was before the blocked rollback attempt");
});

test("Rev193: a historical rollback target that remains compatible with the current controls (no protected-floor conflict) succeeds normally", () => {
  const store = freshStore();
  const identity = { tenantId: tenantScope.tenantId };
  const first = resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-default", version: "1" })],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  resolveAndProjectConfigurationPolicyDecision({
    store,
    identity,
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  });

  const result = rollbackConfigurationPolicyDecision({
    store,
    identity,
    authority: protectedAuthority(),
    rollbackToDecisionId: "decision-1",
    // The current control for "theme" is ordinary (not protectedFloor) - a
    // drift from the target exists, but since it is not a protected floor,
    // rollback is not disqualified.
    currentControls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-3",
    now: "2026-10-06T00:02:00.000Z",
  });

  assert.equal(result.kind, "ROLLED_BACK");
  assert.ok(result.kind === "ROLLED_BACK");
  assert.deepEqual(result.entry.resolution, first.resolution);
  assert.equal(result.entry.rolledBackToDecisionId, "decision-1");

  const active = store.getActiveDecisionProjection(tenantScope.tenantId, first.entry.decisionKey);
  assert.deepEqual(active, result.entry);
});
