import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import {
  resolveEffectiveConfigurationPolicy,
  InvalidEffectiveConfigurationPolicyError,
  type EffectiveConfigurationPolicyRequest,
} from "../src/domain/effective-configuration-policy.js";

const tenantScope = createTenantScope("tenant-os-v0-04");
const customer = createCustomer({ tenantScope, customerId: "cust-os-v0-04", displayName: "OS-V0-04 Customer" });
const project = createProject({
  tenantScope,
  customer,
  projectId: "project-os-v0-04",
  ownerRef: "owner-os-v0-04",
  state: "active",
});

function baseRequest(overrides: Partial<EffectiveConfigurationPolicyRequest> = {}): EffectiveConfigurationPolicyRequest {
  return {
    tenantId: tenantScope.tenantId,
    controls: [],
    ...overrides,
  };
}

function platformControl(overrides: Record<string, unknown> = {}) {
  return {
    kind: "CONFIG",
    scope: "PLATFORM",
    key: "theme",
    sourceRef: "platform-default-theme",
    version: "1",
    identity: {},
    ...overrides,
  };
}

test("A1: platform-only CONFIG and POLICY refs resolve deterministically with full provenance", () => {
  const request = baseRequest({
    controls: [
      { kind: "CONFIG", scope: "PLATFORM", key: "theme", sourceRef: "platform-theme-default", version: "1", identity: {} },
      { kind: "POLICY", scope: "PLATFORM", key: "retention", sourceRef: "platform-retention-default", version: "1", identity: {} },
    ],
  });
  const first = resolveEffectiveConfigurationPolicy(request);
  const second = resolveEffectiveConfigurationPolicy(request);
  assert.deepEqual(first, second, "resolution must be deterministic for identical input");
  assert.deepEqual(first.effectiveConfigRefs, [JSON.stringify(["theme", "1", "platform-theme-default"])]);
  assert.deepEqual(first.effectivePolicyRefs, [JSON.stringify(["retention", "1", "platform-retention-default"])]);
  assert.deepEqual(first.effectiveControls, [
    { kind: "CONFIG", key: "theme", scope: "PLATFORM", sourceRef: "platform-theme-default", version: "1", protectedFloor: false },
    { kind: "POLICY", key: "retention", scope: "PLATFORM", sourceRef: "platform-retention-default", version: "1", protectedFloor: false },
  ]);
});

test("A2: an organization ordinary control overrides the same kind+key platform ordinary control", () => {
  const request = baseRequest({
    controls: [
      platformControl({ sourceRef: "platform-theme-default", version: "1" }),
      { kind: "CONFIG", scope: "ORGANIZATION", key: "theme", sourceRef: "org-theme-dark", version: "2", identity: { tenantId: tenantScope.tenantId } },
    ],
  });
  const result = resolveEffectiveConfigurationPolicy(request);
  assert.deepEqual(result.effectiveConfigRefs, [JSON.stringify(["theme", "2", "org-theme-dark"])]);
  assert.equal(result.effectiveControls.length, 1);
  assert.equal(result.effectiveControls[0]?.scope, "ORGANIZATION");
});

test("A3: customer overrides organization; project overrides customer; job overrides project; action overrides job for ordinary controls", () => {
  const request = baseRequest({
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: "job-os-v0-04",
    actionRef: "action-os-v0-04",
    controls: [
      { kind: "CONFIG", scope: "ORGANIZATION", key: "limit", sourceRef: "org-limit", version: "1", identity: { tenantId: tenantScope.tenantId } },
      { kind: "CONFIG", scope: "CUSTOMER", key: "limit", sourceRef: "customer-limit", version: "2", identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId } },
      { kind: "CONFIG", scope: "PROJECT", key: "limit", sourceRef: "project-limit", version: "3", identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId } },
      { kind: "CONFIG", scope: "JOB", key: "limit", sourceRef: "job-limit", version: "4", identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId, jobId: "job-os-v0-04" } },
      { kind: "CONFIG", scope: "ACTION", key: "limit", sourceRef: "action-limit", version: "5", identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId, jobId: "job-os-v0-04", actionRef: "action-os-v0-04" } },
    ],
  });
  const result = resolveEffectiveConfigurationPolicy(request);
  assert.equal(result.effectiveControls.length, 1);
  assert.equal(result.effectiveControls[0]?.scope, "ACTION");
  assert.deepEqual(result.effectiveConfigRefs, [JSON.stringify(["limit", "5", "action-limit"])]);

  // Remove the ACTION entry: JOB should now win.
  const withoutAction = resolveEffectiveConfigurationPolicy({
    ...request,
    controls: request.controls.slice(0, 4),
  });
  assert.equal(withoutAction.effectiveControls[0]?.scope, "JOB");
});

test("A4: a protected PLATFORM floor for a key cannot be replaced by organization/customer/project/job/action", () => {
  const request = baseRequest({
    customerId: customer.customerId,
    controls: [
      { kind: "POLICY", scope: "PLATFORM", key: "data-residency", sourceRef: "platform-residency", version: "1", identity: {}, protectedFloor: true },
      { kind: "POLICY", scope: "ORGANIZATION", key: "data-residency", sourceRef: "org-residency-override", version: "2", identity: { tenantId: tenantScope.tenantId } },
    ],
  });
  assert.throws(() => resolveEffectiveConfigurationPolicy(request), InvalidEffectiveConfigurationPolicyError);

  // Without the override attempt, the protected floor resolves cleanly.
  const clean = resolveEffectiveConfigurationPolicy({ ...request, controls: request.controls.slice(0, 1) });
  assert.deepEqual(clean.effectivePolicyRefs, [JSON.stringify(["data-residency", "1", "platform-residency"])]);
  assert.equal(clean.effectiveControls[0]?.protectedFloor, true);
});

test("A5: unrelated keys from multiple scopes coexist and output ordering is deterministic independent of input order", () => {
  const controlsInOneOrder = [
    { kind: "CONFIG", scope: "PLATFORM", key: "zeta", sourceRef: "platform-zeta", version: "1", identity: {} },
    { kind: "CONFIG", scope: "ORGANIZATION", key: "alpha", sourceRef: "org-alpha", version: "1", identity: { tenantId: tenantScope.tenantId } },
    { kind: "POLICY", scope: "PLATFORM", key: "beta", sourceRef: "platform-beta", version: "1", identity: {} },
  ];
  const resultA = resolveEffectiveConfigurationPolicy(baseRequest({ controls: controlsInOneOrder }));
  const resultB = resolveEffectiveConfigurationPolicy(
    baseRequest({ controls: [...controlsInOneOrder].reverse() }),
  );
  assert.deepEqual(resultA, resultB, "output must not depend on caller array order");
  assert.deepEqual(resultA.effectiveConfigRefs, [
    JSON.stringify(["alpha", "1", "org-alpha"]),
    JSON.stringify(["zeta", "1", "platform-zeta"]),
  ]);
  assert.deepEqual(resultA.effectivePolicyRefs, [JSON.stringify(["beta", "1", "platform-beta"])]);
});

test("A6: duplicate same kind+key within one scope fails closed as ambiguous", () => {
  const request = baseRequest({
    controls: [
      platformControl({ sourceRef: "platform-theme-a", version: "1" }),
      platformControl({ sourceRef: "platform-theme-b", version: "2" }),
    ],
  });
  assert.throws(() => resolveEffectiveConfigurationPolicy(request), InvalidEffectiveConfigurationPolicyError);
});

test("Rev143 F1 (adversarial): two distinct (key, version, sourceRef) tuples that collide under raw '@'/'#' concatenation produce distinct effective refs under the corrected JSON-tuple encoding", () => {
  // key="a@b"/version="c"/sourceRef="d" and key="a"/version="b@c"/sourceRef="d"
  // both concatenate to the literal string "a@b@c#d" under the old, rejected
  // `${key}@${version}#${sourceRef}` formula - the exact Rev143 F1 collision
  // shape, at the effective-ref-encoding level rather than the durable-store
  // key level (Rev44 F2's original instance of this same defect class).
  const oldFormulaA = `${"a@b"}@${"c"}#${"d"}`;
  const oldFormulaB = `${"a"}@${"b@c"}#${"d"}`;
  assert.equal(
    oldFormulaA,
    oldFormulaB,
    "sanity: the old raw concatenation formula must collide for this adversarial pair",
  );

  const request = baseRequest({
    controls: [
      { kind: "CONFIG", scope: "PLATFORM", key: "a@b", sourceRef: "d", version: "c", identity: {} },
      { kind: "CONFIG", scope: "PLATFORM", key: "a", sourceRef: "d", version: "b@c", identity: {} },
    ],
  });
  const result = resolveEffectiveConfigurationPolicy(request);
  assert.equal(result.effectiveConfigRefs.length, 2);
  assert.notEqual(result.effectiveConfigRefs[0], result.effectiveConfigRefs[1]);
});

test("A7: a foreign-tenant organization layer fails closed", () => {
  const request = baseRequest({
    controls: [
      { kind: "CONFIG", scope: "ORGANIZATION", key: "theme", sourceRef: "org-theme", version: "1", identity: { tenantId: "tenant-os-v0-04-foreign" } },
    ],
  });
  assert.throws(() => resolveEffectiveConfigurationPolicy(request), InvalidEffectiveConfigurationPolicyError);
});

test("A8: a wrong-customer layer against the supplied customer/project context fails closed", () => {
  const request = baseRequest({
    customerId: customer.customerId,
    controls: [
      { kind: "CONFIG", scope: "CUSTOMER", key: "theme", sourceRef: "customer-theme", version: "1", identity: { tenantId: tenantScope.tenantId, customerId: "cust-os-v0-04-foreign" } },
    ],
  });
  assert.throws(() => resolveEffectiveConfigurationPolicy(request), InvalidEffectiveConfigurationPolicyError);
});

test("A9: a wrong-project layer fails closed", () => {
  const request = baseRequest({
    customerId: customer.customerId,
    projectId: project.projectId,
    controls: [
      {
        kind: "CONFIG",
        scope: "PROJECT",
        key: "theme",
        sourceRef: "project-theme",
        version: "1",
        identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: "project-os-v0-04-foreign" },
      },
    ],
  });
  assert.throws(() => resolveEffectiveConfigurationPolicy(request), InvalidEffectiveConfigurationPolicyError);
});

test("A10: job/action controls require the exact supplied parent context and reject mismatched job/action target", () => {
  const projectScopedRequest = baseRequest({
    customerId: customer.customerId,
    projectId: project.projectId,
    // no jobId supplied at the request level
    controls: [
      {
        kind: "CONFIG",
        scope: "JOB",
        key: "theme",
        sourceRef: "job-theme",
        version: "1",
        identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId, jobId: "job-os-v0-04" },
      },
    ],
  });
  assert.throws(
    () => resolveEffectiveConfigurationPolicy(projectScopedRequest),
    InvalidEffectiveConfigurationPolicyError,
    "a JOB control must fail closed when the request supplies no jobId at all",
  );

  const mismatchedJobRequest = baseRequest({
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: "job-os-v0-04-actual",
    controls: [
      {
        kind: "CONFIG",
        scope: "JOB",
        key: "theme",
        sourceRef: "job-theme",
        version: "1",
        identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId, projectId: project.projectId, jobId: "job-os-v0-04-different" },
      },
    ],
  });
  assert.throws(
    () => resolveEffectiveConfigurationPolicy(mismatchedJobRequest),
    InvalidEffectiveConfigurationPolicyError,
    "a JOB control targeting a different jobId than the request must fail closed",
  );

  const mismatchedActionRequest = baseRequest({
    customerId: customer.customerId,
    projectId: project.projectId,
    jobId: "job-os-v0-04",
    actionRef: "action-actual",
    controls: [
      {
        kind: "CONFIG",
        scope: "ACTION",
        key: "theme",
        sourceRef: "action-theme",
        version: "1",
        identity: {
          tenantId: tenantScope.tenantId,
          customerId: customer.customerId,
          projectId: project.projectId,
          jobId: "job-os-v0-04",
          actionRef: "action-different",
        },
      },
    ],
  });
  assert.throws(
    () => resolveEffectiveConfigurationPolicy(mismatchedActionRequest),
    InvalidEffectiveConfigurationPolicyError,
    "an ACTION control targeting a different actionRef than the request must fail closed",
  );
});

test("A11: malformed/empty key/sourceRef/version/scope/identity fails closed, including a hand-built plain-object bypass", () => {
  const getState = () => baseRequest();

  assert.throws(
    () => resolveEffectiveConfigurationPolicy({ ...getState(), controls: [{ kind: "CONFIG", scope: "PLATFORM", key: "", sourceRef: "x", version: "1", identity: {} }] }),
    InvalidEffectiveConfigurationPolicyError,
    "empty key must be rejected",
  );
  assert.throws(
    () => resolveEffectiveConfigurationPolicy({ ...getState(), controls: [{ kind: "CONFIG", scope: "PLATFORM", key: "k", sourceRef: "  ", version: "1", identity: {} }] }),
    InvalidEffectiveConfigurationPolicyError,
    "whitespace-only sourceRef must be rejected",
  );
  assert.throws(
    () => resolveEffectiveConfigurationPolicy({ ...getState(), controls: [{ kind: "CONFIG", scope: "PLATFORM", key: "k", sourceRef: "x", version: "", identity: {} }] }),
    InvalidEffectiveConfigurationPolicyError,
    "empty version must be rejected",
  );
  assert.throws(
    () => resolveEffectiveConfigurationPolicy({ ...getState(), controls: [{ kind: "CONFIG", scope: "GALAXY", key: "k", sourceRef: "x", version: "1", identity: {} }] }),
    InvalidEffectiveConfigurationPolicyError,
    "unrecognized scope must be rejected",
  );
  assert.throws(
    () => resolveEffectiveConfigurationPolicy({ ...getState(), controls: [{ kind: "CONFIG", scope: "ORGANIZATION", key: "k", sourceRef: "x", version: "1", identity: {} }] }),
    InvalidEffectiveConfigurationPolicyError,
    "an ORGANIZATION control missing identity.tenantId must be rejected",
  );
  assert.throws(
    () =>
      resolveEffectiveConfigurationPolicy({
        ...getState(),
        controls: [{ kind: "CONFIG", scope: "PLATFORM", key: "k", sourceRef: "x", version: "1", identity: {}, protectedFloor: "yes" }],
      }),
    InvalidEffectiveConfigurationPolicyError,
    "non-boolean protectedFloor must be rejected",
  );
  assert.throws(
    () =>
      resolveEffectiveConfigurationPolicy({
        ...getState(),
        customerId: customer.customerId,
        controls: [
          {
            kind: "CONFIG",
            scope: "CUSTOMER",
            key: "k",
            sourceRef: "x",
            version: "1",
            identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId },
            protectedFloor: true,
          },
        ],
      }),
    InvalidEffectiveConfigurationPolicyError,
    "protectedFloor: true on a non-PLATFORM scope must be rejected",
  );

  // Direct-interface bypass: a hand-built plain object using the exported
  // interface's own shape, never constructed through any factory, must
  // still be fully revalidated at this boundary rather than trusted.
  const forged = { kind: "CONFIG", scope: "PLATFORM" } as unknown;
  assert.throws(
    () => resolveEffectiveConfigurationPolicy({ ...getState(), controls: [forged] }),
    InvalidEffectiveConfigurationPolicyError,
    "a hand-built control missing required fields must still fail closed",
  );
});

test("A12: resolver output separates CONFIG vs POLICY refs and retains selected scope/sourceRef/version readback/provenance", () => {
  const request = baseRequest({
    customerId: customer.customerId,
    controls: [
      { kind: "CONFIG", scope: "PLATFORM", key: "theme", sourceRef: "platform-theme", version: "1", identity: {} },
      { kind: "POLICY", scope: "CUSTOMER", key: "retention", sourceRef: "customer-retention", version: "3", identity: { tenantId: tenantScope.tenantId, customerId: customer.customerId } },
    ],
  });
  const result = resolveEffectiveConfigurationPolicy(request);
  assert.deepEqual(result.effectiveConfigRefs, [JSON.stringify(["theme", "1", "platform-theme"])]);
  assert.deepEqual(result.effectivePolicyRefs, [JSON.stringify(["retention", "3", "customer-retention"])]);
  const themeControl = result.effectiveControls.find((c) => c.key === "theme");
  const retentionControl = result.effectiveControls.find((c) => c.key === "retention");
  assert.deepEqual(themeControl, { kind: "CONFIG", key: "theme", scope: "PLATFORM", sourceRef: "platform-theme", version: "1", protectedFloor: false });
  assert.deepEqual(retentionControl, { kind: "POLICY", key: "retention", scope: "CUSTOMER", sourceRef: "customer-retention", version: "3", protectedFloor: false });
});

// ---------------------------------------------------------------------------
// A14: boundary/dependency scan
// ---------------------------------------------------------------------------

test("A14/boundary: effective-configuration-policy.ts imports only tenant-scope/customer/project types, is pure (no fs/network/clock/randomness/persistence), and no new runtime dependency was introduced", () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const sourcePath = join(REPO_ROOT, "src/domain/effective-configuration-policy.ts");
  const content = readFileSync(sourcePath, "utf8");

  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  const allowedModules = ["./tenant-scope.js", "./customer.js", "./project.js"];
  for (const specifier of importedModules) {
    assert.ok(allowedModules.includes(specifier ?? ""), `unexpected import specifier: ${specifier}`);
  }

  const forbidden: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    { label: "persistence/store", pattern: /\b(fs\.|node:fs|readFile|writeFile|Database|Repository)\b/ },
    { label: "network/HTTP/fetch", pattern: /\b(fetch\(|node:http|node:https|XMLHttpRequest)\b/ },
    { label: "clock/randomness", pattern: /\b(Date\.now\(\)|Math\.random\(\)|new Date\(\))\b/ },
    { label: "authority/approval coupling", pattern: /\b(AuthorityContext|ApprovalReference|requirePermission|requireProtectedActionAuthorization)\b/ },
    { label: "worker-routing coupling", pattern: /\b(AdmittedWorker|WorkerRoutingRequest|resolveWorkerRoute)\b/ },
  ];
  for (const { label, pattern } of forbidden) {
    assert.equal(pattern.test(content), false, `found forbidden pattern "${label}" in effective-configuration-policy.ts`);
  }

  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(Object.keys(packageJson.dependencies ?? {}), []);
  assert.deepEqual(Object.keys(packageJson.devDependencies ?? {}).sort(), ["@types/node", "typescript"]);
});
