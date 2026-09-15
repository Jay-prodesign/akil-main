import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { resolveAppConfig, type AppConfig } from "../src/runtime/app-config.js";
import {
  registerDeploymentEnvironment,
  resolveConfigDrift,
  createCutoverPlan,
  passPreflight,
  markMigrationsApplied,
  markTrafficSwitched,
  verifyCutoverReadback,
  initiateRollback,
  proposeDnsChange,
  withdrawDnsChangeProposal,
  InvalidDeploymentOrchestrationError,
  InvalidCutoverTransitionError,
} from "../src/domain/deployment-orchestration.js";

const tenantScope = createTenantScope("tenant-dep-1");

function environment(tier: AppConfig["deploymentEnv"] = "production") {
  return registerDeploymentEnvironment({
    tenantScope,
    environmentRef: "prod-us",
    tier,
    boundSecretRefs: ["secret-1", "secret-2"],
  });
}

function noDriftReport() {
  const config = resolveAppConfig({ PORT: "8080", DEPLOYMENT_ENV: "production", PERSISTENCE_DRIVER: "FILE" });
  return resolveConfigDrift({ desired: config, observed: config });
}

// --- registerDeploymentEnvironment ---

test("D1: registerDeploymentEnvironment binds environmentRef/tier/secretRefs", () => {
  const env = environment();
  assert.equal(env.environmentRef, "prod-us");
  assert.equal(env.tier, "production");
  assert.deepEqual(env.boundSecretRefs, ["secret-1", "secret-2"]);
});

test("D2: registerDeploymentEnvironment rejects an unrecognized tier", () => {
  assert.throws(
    () =>
      registerDeploymentEnvironment({
        tenantScope,
        environmentRef: "prod-us",
        tier: "sandbox",
        boundSecretRefs: [],
      }),
    InvalidDeploymentOrchestrationError,
  );
});

test("D3: registerDeploymentEnvironment rejects a non-array boundSecretRefs", () => {
  assert.throws(
    () =>
      registerDeploymentEnvironment({
        tenantScope,
        environmentRef: "prod-us",
        tier: "production",
        boundSecretRefs: "secret-1" as unknown as [],
      }),
    InvalidDeploymentOrchestrationError,
  );
});

test("D4: registerDeploymentEnvironment accepts an empty boundSecretRefs array", () => {
  const env = registerDeploymentEnvironment({ tenantScope, environmentRef: "dev-1", tier: "development", boundSecretRefs: [] });
  assert.deepEqual(env.boundSecretRefs, []);
});

// --- resolveConfigDrift ---

test("D5: resolveConfigDrift reports NO_DRIFT for identical configs", () => {
  const config = resolveAppConfig({ PORT: "8080", DEPLOYMENT_ENV: "production", PERSISTENCE_DRIVER: "FILE" });
  const report = resolveConfigDrift({ desired: config, observed: config });
  assert.equal(report.status, "NO_DRIFT");
  assert.deepEqual(report.driftedFields, []);
});

test("D6 (adversarial config drift): resolveConfigDrift detects a port mismatch", () => {
  const desired = resolveAppConfig({ PORT: "8080", DEPLOYMENT_ENV: "production", PERSISTENCE_DRIVER: "FILE" });
  const observed = resolveAppConfig({ PORT: "9090", DEPLOYMENT_ENV: "production", PERSISTENCE_DRIVER: "FILE" });
  const report = resolveConfigDrift({ desired, observed });
  assert.equal(report.status, "DRIFT_DETECTED");
  assert.deepEqual(report.driftedFields, ["port"]);
});

test("D7: resolveConfigDrift detects a persistenceDriver mismatch", () => {
  const desired = resolveAppConfig({ PORT: "8080", DEPLOYMENT_ENV: "production", PERSISTENCE_DRIVER: "FILE" });
  const observed = resolveAppConfig({
    PORT: "8080",
    DEPLOYMENT_ENV: "production",
    PERSISTENCE_DRIVER: "POSTGRES",
    DATABASE_URL: "postgres://x",
  });
  const report = resolveConfigDrift({ desired, observed });
  assert.ok(report.driftedFields.includes("persistenceDriver"));
  assert.ok(report.driftedFields.includes("databaseUrl"));
});

// --- Cutover lifecycle ---

test("D8: createCutoverPlan starts PLANNED", () => {
  const plan = createCutoverPlan({ environment: environment(), migrationRefs: ["0001_outcome_jobs"], cutoverRef: "cutover-1" });
  assert.equal(plan.status, "PLANNED");
});

test("D9 (the one required gate): passPreflight fails closed when drift is detected", () => {
  const plan = createCutoverPlan({ environment: environment(), migrationRefs: [], cutoverRef: "cutover-2" });
  const desired = resolveAppConfig({ PORT: "8080", DEPLOYMENT_ENV: "production", PERSISTENCE_DRIVER: "FILE" });
  const observed = resolveAppConfig({ PORT: "9090", DEPLOYMENT_ENV: "production", PERSISTENCE_DRIVER: "FILE" });
  const driftReport = resolveConfigDrift({ desired, observed });
  assert.throws(() => passPreflight({ plan, driftReport }), InvalidCutoverTransitionError);
});

test("D10: passPreflight succeeds when NO_DRIFT", () => {
  const plan = createCutoverPlan({ environment: environment(), migrationRefs: [], cutoverRef: "cutover-3" });
  const passed = passPreflight({ plan, driftReport: noDriftReport() });
  assert.equal(passed.status, "PREFLIGHT_PASSED");
});

test("D11: full happy-path cutover reaches VERIFIED via a confirming readback", () => {
  let plan = createCutoverPlan({ environment: environment(), migrationRefs: ["0001_outcome_jobs"], cutoverRef: "cutover-4" });
  plan = passPreflight({ plan, driftReport: noDriftReport() });
  plan = markMigrationsApplied({ plan, evidenceRef: "evidence:migrations" });
  plan = markTrafficSwitched({ plan, evidenceRef: "evidence:traffic" });
  plan = verifyCutoverReadback({ plan, readbackConfirmsHealthy: true, evidenceRef: "evidence:readback" });
  assert.equal(plan.status, "VERIFIED");
});

test("D12 (readback authoritative over claimed outcome): a disproving readback corrects TRAFFIC_SWITCHED to ROLLED_BACK, not left falsely advanced", () => {
  let plan = createCutoverPlan({ environment: environment(), migrationRefs: [], cutoverRef: "cutover-5" });
  plan = passPreflight({ plan, driftReport: noDriftReport() });
  plan = markMigrationsApplied({ plan, evidenceRef: "evidence:migrations" });
  plan = markTrafficSwitched({ plan, evidenceRef: "evidence:traffic" });
  plan = verifyCutoverReadback({ plan, readbackConfirmsHealthy: false, evidenceRef: "evidence:readback-failed" });
  assert.equal(plan.status, "ROLLED_BACK");
});

test("D13 (adversarial out-of-order transition): markMigrationsApplied fails closed on a PLANNED (not yet preflighted) cutover", () => {
  const plan = createCutoverPlan({ environment: environment(), migrationRefs: [], cutoverRef: "cutover-6" });
  assert.throws(() => markMigrationsApplied({ plan, evidenceRef: "evidence:x" }), InvalidCutoverTransitionError);
});

test("D14: initiateRollback aborts a PREFLIGHT_PASSED cutover", () => {
  const plan0 = createCutoverPlan({ environment: environment(), migrationRefs: [], cutoverRef: "cutover-7" });
  const plan = passPreflight({ plan: plan0, driftReport: noDriftReport() });
  const rolledBack = initiateRollback({ plan, reason: "unexpected downstream failure", evidenceRef: "evidence:x" });
  assert.equal(rolledBack.status, "ROLLED_BACK");
  assert.equal(rolledBack.rollbackReason, "unexpected downstream failure");
});

test("D15 (adversarial double-rollback): initiateRollback fails closed on an already-terminal (VERIFIED) cutover", () => {
  let plan = createCutoverPlan({ environment: environment(), migrationRefs: [], cutoverRef: "cutover-8" });
  plan = passPreflight({ plan, driftReport: noDriftReport() });
  plan = markMigrationsApplied({ plan, evidenceRef: "evidence:x" });
  plan = markTrafficSwitched({ plan, evidenceRef: "evidence:y" });
  plan = verifyCutoverReadback({ plan, readbackConfirmsHealthy: true, evidenceRef: "evidence:z" });
  assert.throws(() => initiateRollback({ plan, reason: "too late", evidenceRef: "evidence:w" }), InvalidCutoverTransitionError);
});

test("D16 (adversarial double-rollback via ROLLED_BACK): initiateRollback fails closed on an already-ROLLED_BACK cutover", () => {
  const plan0 = createCutoverPlan({ environment: environment(), migrationRefs: [], cutoverRef: "cutover-9" });
  const rolledBack = initiateRollback({ plan: plan0, reason: "first rollback", evidenceRef: "evidence:x" });
  assert.throws(() => initiateRollback({ plan: rolledBack, reason: "second attempt", evidenceRef: "evidence:y" }), InvalidCutoverTransitionError);
});

// --- DNS proposal ---

test("D17: proposeDnsChange is always born PROPOSED", () => {
  const proposal = proposeDnsChange({ environment: environment(), recordType: "CNAME", name: "app.example.com", target: "cdn.example.net", ttlSeconds: 300 });
  assert.equal(proposal.status, "PROPOSED");
});

test("D18: proposeDnsChange rejects an unrecognized recordType", () => {
  assert.throws(
    () => proposeDnsChange({ environment: environment(), recordType: "PTR", name: "app.example.com", target: "x", ttlSeconds: 300 }),
    InvalidDeploymentOrchestrationError,
  );
});

test("D19: proposeDnsChange rejects a non-positive ttlSeconds", () => {
  assert.throws(
    () => proposeDnsChange({ environment: environment(), recordType: "A", name: "app.example.com", target: "1.2.3.4", ttlSeconds: 0 }),
    InvalidDeploymentOrchestrationError,
  );
});

test("D20: withdrawDnsChangeProposal transitions PROPOSED to WITHDRAWN", () => {
  const proposal = proposeDnsChange({ environment: environment(), recordType: "A", name: "app.example.com", target: "1.2.3.4", ttlSeconds: 300 });
  const withdrawn = withdrawDnsChangeProposal(proposal);
  assert.equal(withdrawn.status, "WITHDRAWN");
});

test("D21 (adversarial double-withdraw): withdrawDnsChangeProposal fails closed on an already-WITHDRAWN proposal", () => {
  const proposal = proposeDnsChange({ environment: environment(), recordType: "A", name: "app.example.com", target: "1.2.3.4", ttlSeconds: 300 });
  const withdrawn = withdrawDnsChangeProposal(proposal);
  assert.throws(() => withdrawDnsChangeProposal(withdrawn), InvalidDeploymentOrchestrationError);
});
