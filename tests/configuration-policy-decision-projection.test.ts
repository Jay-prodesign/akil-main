import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  InvalidConfigurationPolicyDecisionProjectionError,
  encodeConfigurationPolicyDecisionKey,
  configurationPolicyResolutionsEqual,
  describeConfigurationPolicyDecisionDrift,
  computeConfigurationPolicyDecisionProjection,
  type ConfigurationPolicyDecisionIdentity,
} from "../src/domain/configuration-policy-decision-projection.js";

const tenantScope = createTenantScope("tenant-os-v0-11");
const customer = createCustomer({ tenantScope, customerId: "cust-os-v0-11", displayName: "OS-V0-11 Customer" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "project-os-v0-11",
  ownerRef: "owner-os-v0-11",
  state: "active",
});

function identity(overrides: Partial<ConfigurationPolicyDecisionIdentity> = {}): ConfigurationPolicyDecisionIdentity {
  return { tenantId: tenantScope.tenantId, ...overrides };
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

test("P1: encodeConfigurationPolicyDecisionKey is deterministic for identical identity", () => {
  const a = encodeConfigurationPolicyDecisionKey(identity({ customerId: customer.customerId }));
  const b = encodeConfigurationPolicyDecisionKey(identity({ customerId: customer.customerId }));
  assert.equal(a, b);
});

test("P2: encodeConfigurationPolicyDecisionKey differs for different customerId/projectId/jobId/actionRef", () => {
  const base = encodeConfigurationPolicyDecisionKey(identity());
  const withCustomer = encodeConfigurationPolicyDecisionKey(identity({ customerId: customer.customerId }));
  const withProject = encodeConfigurationPolicyDecisionKey(
    identity({ customerId: customer.customerId, projectId: project.projectId }),
  );
  const withJob = encodeConfigurationPolicyDecisionKey(
    identity({ customerId: customer.customerId, projectId: project.projectId, jobId: "job-1" }),
  );
  const withAction = encodeConfigurationPolicyDecisionKey(
    identity({ customerId: customer.customerId, projectId: project.projectId, jobId: "job-1", actionRef: "action-1" }),
  );
  const allKeys = [base, withCustomer, withProject, withJob, withAction];
  assert.equal(new Set(allKeys).size, allKeys.length, "every distinct identity must produce a distinct decisionKey");
});

test("P3: encodeConfigurationPolicyDecisionKey rejects an actionRef without a jobId", () => {
  assert.throws(
    () => encodeConfigurationPolicyDecisionKey(identity({ actionRef: "action-1" })),
    InvalidConfigurationPolicyDecisionProjectionError,
  );
});

test("P4: encodeConfigurationPolicyDecisionKey rejects an empty tenantId", () => {
  assert.throws(
    () => encodeConfigurationPolicyDecisionKey({ tenantId: "" as never }),
    InvalidConfigurationPolicyDecisionProjectionError,
  );
});

test("P5: configurationPolicyResolutionsEqual is true for two resolutions of identical controls", () => {
  const entryA = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  const entryB = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl()],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  });
  assert.equal(configurationPolicyResolutionsEqual(entryA.resolution, entryB.resolution), true);
});

test("P6: configurationPolicyResolutionsEqual is false when a control's version/sourceRef differs", () => {
  const entryA = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  const entryB = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  });
  assert.equal(configurationPolicyResolutionsEqual(entryA.resolution, entryB.resolution), false);
});

test("P7: configurationPolicyResolutionsEqual is false when control count differs", () => {
  const entryA = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  });
  const entryB = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl(), { kind: "POLICY", scope: "PLATFORM", key: "retention", sourceRef: "r", version: "1", identity: {} }],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  });
  assert.equal(configurationPolicyResolutionsEqual(entryA.resolution, entryB.resolution), false);
});

test("P8: describeConfigurationPolicyDecisionDrift against an undefined previous reports every fresh control as a new drift entry", () => {
  const fresh = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  }).resolution;
  const drift = describeConfigurationPolicyDecisionDrift(undefined, fresh);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.previousControl, undefined);
  assert.equal(drift[0]?.freshControl?.sourceRef, "platform-theme-default");
});

test("P9: describeConfigurationPolicyDecisionDrift is empty for two identical resolutions", () => {
  const resolutionA = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  }).resolution;
  const resolutionB = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl()],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  }).resolution;
  assert.deepEqual(describeConfigurationPolicyDecisionDrift(resolutionA, resolutionB), []);
});

test("P10: describeConfigurationPolicyDecisionDrift names exactly the changed key with both sides' controls when one key's version/sourceRef changes", () => {
  const previous = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl()],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  }).resolution;
  const fresh = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl({ sourceRef: "platform-theme-dark", version: "2" })],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  }).resolution;
  const drift = describeConfigurationPolicyDecisionDrift(previous, fresh);
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.kind, "CONFIG");
  assert.equal(drift[0]?.key, "theme");
  assert.equal(drift[0]?.previousControl?.sourceRef, "platform-theme-default");
  assert.equal(drift[0]?.freshControl?.sourceRef, "platform-theme-dark");
});

test("P11: describeConfigurationPolicyDecisionDrift reports a disappeared key with freshControl undefined, and an appeared key with previousControl undefined", () => {
  const previous = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl({ key: "theme" })],
    decisionId: "decision-1",
    now: "2026-10-06T00:00:00.000Z",
  }).resolution;
  const fresh = computeConfigurationPolicyDecisionProjection({
    identity: identity(),
    controls: [platformControl({ key: "retention", sourceRef: "r", version: "1" })],
    decisionId: "decision-2",
    now: "2026-10-06T00:01:00.000Z",
  }).resolution;
  const drift = describeConfigurationPolicyDecisionDrift(previous, fresh);
  assert.equal(drift.length, 2);
  const disappeared = drift.find((d) => d.key === "theme")!;
  assert.equal(disappeared.freshControl, undefined);
  assert.notEqual(disappeared.previousControl, undefined);
  const appeared = drift.find((d) => d.key === "retention")!;
  assert.equal(appeared.previousControl, undefined);
  assert.notEqual(appeared.freshControl, undefined);
});

test("P12: computeConfigurationPolicyDecisionProjection wraps resolveEffectiveConfigurationPolicy verbatim and stamps entryKind COMPUTED with the exact decisionKey/decisionId/now/inputControlsSnapshot supplied", () => {
  const controls = [platformControl()];
  const entry = computeConfigurationPolicyDecisionProjection({
    identity: identity({ customerId: customer.customerId }),
    controls,
    decisionId: "decision-42",
    now: "2026-10-06T00:00:00.000Z",
  });
  assert.equal(entry.decisionKey, encodeConfigurationPolicyDecisionKey(identity({ customerId: customer.customerId })));
  assert.equal(entry.decisionId, "decision-42");
  assert.equal(entry.computedAt, "2026-10-06T00:00:00.000Z");
  assert.equal(entry.entryKind, "COMPUTED");
  assert.deepEqual(entry.inputControlsSnapshot, controls);
  assert.deepEqual(entry.resolution.effectiveConfigRefs, [JSON.stringify(["theme", "1", "platform-theme-default"])]);
});

test("P13: computeConfigurationPolicyDecisionProjection rejects an empty decisionId or now", () => {
  assert.throws(
    () =>
      computeConfigurationPolicyDecisionProjection({
        identity: identity(),
        controls: [],
        decisionId: "",
        now: "2026-10-06T00:00:00.000Z",
      }),
    InvalidConfigurationPolicyDecisionProjectionError,
  );
  assert.throws(
    () =>
      computeConfigurationPolicyDecisionProjection({
        identity: identity(),
        controls: [],
        decisionId: "decision-1",
        now: "",
      }),
    InvalidConfigurationPolicyDecisionProjectionError,
  );
});

test("P14: computeConfigurationPolicyDecisionProjection propagates the resolver's own fail-closed errors (e.g. a protected PLATFORM floor override attempt) unchanged", () => {
  assert.throws(() =>
    computeConfigurationPolicyDecisionProjection({
      identity: identity({ customerId: customer.customerId }),
      controls: [
        platformControl({ protectedFloor: true }),
        {
          kind: "CONFIG",
          scope: "ORGANIZATION",
          key: "theme",
          sourceRef: "org-theme-dark",
          version: "2",
          identity: { tenantId: tenantScope.tenantId },
        },
      ],
      decisionId: "decision-1",
      now: "2026-10-06T00:00:00.000Z",
    }),
  );
});
