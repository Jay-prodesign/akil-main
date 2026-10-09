import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createOrganizationServicePrincipal,
  isOrganizationServicePrincipalActive,
  revokeOrganizationServicePrincipal,
  InvalidOrganizationServicePrincipalError,
  InvalidOrganizationServicePrincipalTransitionError,
  type OrganizationServicePrincipal,
} from "../src/domain/organization-service-principal.js";

const tenantScope = createTenantScope("tenant-os-v0-02-sp");
const otherTenantScope = createTenantScope("tenant-os-v0-02-sp-other");

function buildServicePrincipal(overrides: {
  servicePrincipalId?: string;
  tenantScope?: typeof tenantScope;
  workerRef?: string;
} = {}): OrganizationServicePrincipal {
  return createOrganizationServicePrincipal({
    servicePrincipalId: overrides.servicePrincipalId ?? "sp-1",
    tenantScope: overrides.tenantScope ?? tenantScope,
    workerRef: overrides.workerRef ?? "worker-1",
  });
}

// ---------------------------------------------------------------------------
// Construction / lifecycle
// ---------------------------------------------------------------------------

test("createOrganizationServicePrincipal always produces a coherent ACTIVE record with no revocation metadata", () => {
  const sp = buildServicePrincipal();
  assert.equal(sp.state, "ACTIVE");
  assert.equal(sp.revokedAt, undefined);
  assert.equal(sp.revokedReason, undefined);
  assert.equal(sp.tenantId, tenantScope.tenantId);
  assert.equal(sp.workerRef, "worker-1");
  assert.equal(isOrganizationServicePrincipalActive(sp), true);
});

test("createOrganizationServicePrincipal is deterministic", () => {
  const a = buildServicePrincipal();
  const b = buildServicePrincipal();
  assert.deepEqual(a, b);
});

test("empty/whitespace servicePrincipalId or workerRef rejects", () => {
  assert.throws(
    () => createOrganizationServicePrincipal({ servicePrincipalId: "", tenantScope, workerRef: "worker-1" }),
    InvalidOrganizationServicePrincipalError,
  );
  assert.throws(
    () => createOrganizationServicePrincipal({ servicePrincipalId: "sp-1", tenantScope, workerRef: "  " }),
    InvalidOrganizationServicePrincipalError,
  );
});

test("revokeOrganizationServicePrincipal transitions ACTIVE -> REVOKED, recording a valid timestamp/reason and preserving identity/tenant/workerRef", () => {
  const sp = buildServicePrincipal();
  const revoked = revokeOrganizationServicePrincipal({
    servicePrincipal: sp,
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "decommissioned",
  });
  assert.equal(revoked.state, "REVOKED");
  assert.equal(revoked.revokedAt, "2026-09-25T00:00:00.000Z");
  assert.equal(revoked.revokedReason, "decommissioned");
  assert.equal(revoked.servicePrincipalId, sp.servicePrincipalId);
  assert.equal(revoked.tenantId, sp.tenantId);
  assert.equal(revoked.workerRef, sp.workerRef);
  assert.equal(isOrganizationServicePrincipalActive(revoked), false);
});

test("a double revoke rejects, and no reactivation API exists", async () => {
  const sp = buildServicePrincipal();
  const revoked = revokeOrganizationServicePrincipal({
    servicePrincipal: sp,
    revokedAt: "2026-09-25T00:00:00.000Z",
    revokedReason: "decommissioned",
  });
  assert.throws(
    () =>
      revokeOrganizationServicePrincipal({
        servicePrincipal: revoked,
        revokedAt: "2026-09-26T00:00:00.000Z",
        revokedReason: "decommissioned again",
      }),
    InvalidOrganizationServicePrincipalTransitionError,
  );
  const moduleExports = await import("../src/domain/organization-service-principal.js");
  assert.equal("reactivateOrganizationServicePrincipal" in moduleExports, false);
  assert.equal("activateOrganizationServicePrincipal" in moduleExports, false);
});

test("revoking from a hand-built incoherent 'ACTIVE' record (already carrying revocation metadata) rejects", () => {
  const sp = buildServicePrincipal();
  const forged = {
    ...sp,
    state: "ACTIVE",
    revokedAt: "2026-01-01T00:00:00.000Z",
    revokedReason: "stale",
  } as unknown as OrganizationServicePrincipal;
  assert.throws(
    () =>
      revokeOrganizationServicePrincipal({
        servicePrincipal: forged,
        revokedAt: "2026-09-25T00:00:00.000Z",
        revokedReason: "decommissioned",
      }),
    InvalidOrganizationServicePrincipalTransitionError,
  );
});

test("malformed/unknown lifecycle shapes are never treated ACTIVE", () => {
  const sp = buildServicePrincipal();
  const unknownState = { ...sp, state: "PENDING" } as unknown as OrganizationServicePrincipal;
  assert.equal(isOrganizationServicePrincipalActive(unknownState), false);
  const { state: _omitted, ...withoutState } = sp;
  assert.equal(isOrganizationServicePrincipalActive(withoutState as unknown as OrganizationServicePrincipal), false);
});

test("ACTIVE carrying stale revokedAt/revokedReason fails lifecycle validation", () => {
  const sp = buildServicePrincipal();
  const staleRevokedAt = { ...sp, revokedAt: "2026-01-01T00:00:00.000Z" } as unknown as OrganizationServicePrincipal;
  assert.equal(isOrganizationServicePrincipalActive(staleRevokedAt), false);
  const staleRevokedReason = { ...sp, revokedReason: "stale" } as unknown as OrganizationServicePrincipal;
  assert.equal(isOrganizationServicePrincipalActive(staleRevokedReason), false);
});

test("REVOKED missing/invalid revokedAt or revokedReason fails lifecycle validation", () => {
  const sp = buildServicePrincipal();
  const missingRevokedAt = { ...sp, state: "REVOKED", revokedReason: "decommissioned" } as unknown as OrganizationServicePrincipal;
  assert.equal(isOrganizationServicePrincipalActive(missingRevokedAt), false);
  const missingRevokedReason = { ...sp, state: "REVOKED", revokedAt: "2026-09-25T00:00:00.000Z" } as unknown as OrganizationServicePrincipal;
  assert.equal(isOrganizationServicePrincipalActive(missingRevokedReason), false);
});

test("revokeOrganizationServicePrincipal rejects an empty/whitespace revokedReason and a malformed revokedAt", () => {
  const sp = buildServicePrincipal();
  assert.throws(
    () => revokeOrganizationServicePrincipal({ servicePrincipal: sp, revokedAt: "2026-09-25T00:00:00.000Z", revokedReason: "" }),
    InvalidOrganizationServicePrincipalTransitionError,
  );
  assert.throws(
    () => revokeOrganizationServicePrincipal({ servicePrincipal: sp, revokedAt: "not-a-date", revokedReason: "decommissioned" }),
    InvalidOrganizationServicePrincipalTransitionError,
  );
});

test("cross-tenant collision: two service principals for the same workerRef under different tenants remain structurally distinct (different tenantId), and no cross-tenant matching logic exists in this module", () => {
  const spA = buildServicePrincipal({ tenantScope, workerRef: "shared-worker" });
  const spB = buildServicePrincipal({ tenantScope: otherTenantScope, workerRef: "shared-worker" });
  assert.notEqual(spA.tenantId, spB.tenantId);
  assert.equal(spA.workerRef, spB.workerRef);
});

// ---------------------------------------------------------------------------
// Boundary/dependency scan
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SP_SOURCE_PATH = "src/domain/organization-service-principal.ts";

test("boundary: organization-service-principal.ts contains no session/provider/store/network/persistence/AI-Commerce dependency, no Date.now/randomness, and no mutable singleton/global registry", () => {
  const content = readFileSync(join(REPO_ROOT, SP_SOURCE_PATH), "utf8");
  const forbidden: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    { label: "persistence/store", pattern: /\b(fs\.|node:fs|readFile|writeFile|Database|Repository)\b/ },
    { label: "network/HTTP/fetch", pattern: /\b(fetch\(|node:http|node:https|XMLHttpRequest)\b/ },
    { label: "provider/secret/credential", pattern: /\b(secret|credential|apiKey|password|token)\b/i },
    { label: "session/identity provider", pattern: /\bSessionContext\b/ },
    { label: "Shopify/AI Commerce coupling", pattern: /\b(shopify|ai[-_]?commerce)\b/i },
    { label: "Date.now/randomness", pattern: /\b(Date\.now\(\)|Math\.random\(\)|new Date\(\))\b/ },
    { label: "mutable singleton/global registry", pattern: /\b(globalThis\.|global\.|let\s+\w+\s*:\s*Map)\b/ },
  ];
  for (const { label, pattern } of forbidden) {
    assert.equal(pattern.test(content), false, `found forbidden pattern "${label}" in ${SP_SOURCE_PATH}`);
  }
});

test("boundary: organization-service-principal.ts imports only tenant-scope.ts - no worker-routing-policy.ts/organization-membership.ts/authority.ts/organization-access-role.ts import (a second worker registry is never created here)", () => {
  const content = readFileSync(join(REPO_ROOT, SP_SOURCE_PATH), "utf8");
  const importedModules = [...content.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(importedModules.length > 0, "expected at least one import statement");
  const allowedModules = ["tenant-scope.js"];
  for (const specifier of importedModules) {
    assert.ok(
      allowedModules.some((mod) => specifier?.includes(mod)),
      `unexpected import specifier: ${specifier}`,
    );
  }
  for (const forbidden of [
    "worker-routing-policy.js",
    "worker-invoker.js",
    "organization-membership.js",
    "authority.js",
    "organization-access-role.js",
    "ownership-assignment.js",
  ]) {
    assert.equal(content.includes(forbidden), false, `must not import "${forbidden}"`);
  }
});

test("boundary: this module has no permission/protected-action concept and no worker trust/admission/capability/cost/availability field at all", async () => {
  const moduleExports = await import("../src/domain/organization-service-principal.js");
  const exportNames = Object.keys(moduleExports);
  assert.equal(exportNames.includes("AuthorityContext"), false);
  assert.equal(exportNames.includes("requirePermission"), false);
  assert.equal(exportNames.includes("AdmittedWorker"), false);
  const sp = buildServicePrincipal();
  for (const forbiddenField of ["permissions", "canPerformProtectedActions", "trustStatus", "availability", "capability", "costWeight"]) {
    assert.equal(forbiddenField in sp, false, `unexpected field "${forbiddenField}" on OrganizationServicePrincipal`);
  }
});
