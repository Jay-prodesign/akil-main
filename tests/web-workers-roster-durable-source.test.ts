import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createOrganizationServicePrincipal,
  revokeOrganizationServicePrincipal,
} from "../src/domain/organization-service-principal.js";
import { FileDurableOrganizationServicePrincipalStore } from "../src/domain/durable-organization-service-principal-store.js";
import { createDurableWorkersRosterSource } from "../src/web/workers-roster-durable-source.js";
import { REVIEW_ORGANIZATION } from "../src/web/internal-os-review-fixtures.js";

/**
 * Gap scan N2: proves `createDurableWorkersRosterSource` genuinely connects
 * `WorkersRosterSource` to the real `FileDurableOrganizationServicePrincipalStore`
 * (ORG-SERVICE-PRINCIPAL-DURABLE-001) - a real temp-dir-backed store, no
 * mocks - mirroring `createDurablePeopleDirectorySource`'s own adapter test
 * discipline: empty tenant, ACTIVE, REVOKED, multiple-principal sort order
 * (delegated to `resolveWorkersRosterView`, not this adapter), and
 * cross-tenant isolation.
 */

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "workers-roster-durable-source-"));
}

test("N2-S1: createDurableWorkersRosterSource returns an empty list for a tenant with no service principals", () => {
  const dir = freshDir();
  try {
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const source = createDurableWorkersRosterSource(store);
    assert.deepEqual(source.listServicePrincipals(REVIEW_ORGANIZATION), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N2-S2: createDurableWorkersRosterSource returns a single stored ACTIVE service principal, unwrapped (no version field)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope(REVIEW_ORGANIZATION.tenantId);
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const servicePrincipal = createOrganizationServicePrincipal({
      servicePrincipalId: "sp-active-1",
      tenantScope,
      workerRef: "worker-active-1",
    });
    store.create(servicePrincipal);

    const source = createDurableWorkersRosterSource(store);
    const listed = source.listServicePrincipals(REVIEW_ORGANIZATION);
    assert.deepEqual(listed, [servicePrincipal]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N2-S3: createDurableWorkersRosterSource returns a REVOKED service principal exactly as stored", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope(REVIEW_ORGANIZATION.tenantId);
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const created = store.create(
      createOrganizationServicePrincipal({
        servicePrincipalId: "sp-revoked-1",
        tenantScope,
        workerRef: "worker-revoked-1",
      }),
    );
    const revoked = revokeOrganizationServicePrincipal({
      servicePrincipal: created.servicePrincipal,
      revokedAt: "2026-02-01T00:00:00.000Z",
      revokedReason: "decommissioned",
    });
    store.revoke({
      tenantId: tenantScope.tenantId,
      servicePrincipalId: created.servicePrincipal.servicePrincipalId,
      expectedVersion: created.version,
      revokedAt: revoked.revokedAt,
      revokedReason: revoked.revokedReason,
    });

    const source = createDurableWorkersRosterSource(store);
    const listed = source.listServicePrincipals(REVIEW_ORGANIZATION);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], revoked);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N2-S4: createDurableWorkersRosterSource returns multiple service principals for the same tenant, unsorted (sort order is resolveWorkersRosterView's responsibility, not this adapter's)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope(REVIEW_ORGANIZATION.tenantId);
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const first = createOrganizationServicePrincipal({ servicePrincipalId: "sp-multi-1", tenantScope, workerRef: "worker-z" });
    const second = createOrganizationServicePrincipal({ servicePrincipalId: "sp-multi-2", tenantScope, workerRef: "worker-a" });
    store.create(first);
    store.create(second);

    const source = createDurableWorkersRosterSource(store);
    const listed = source.listServicePrincipals(REVIEW_ORGANIZATION);
    assert.equal(listed.length, 2);
    assert.deepEqual(
      new Set(listed.map((sp) => sp.servicePrincipalId)),
      new Set([first.servicePrincipalId, second.servicePrincipalId]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N2-S5: createDurableWorkersRosterSource never leaks a different tenant's service principal into this tenant's roster", () => {
  const dir = freshDir();
  try {
    const ownTenantScope = createTenantScope(REVIEW_ORGANIZATION.tenantId);
    const foreignTenantScope = createTenantScope("tenant-n2-foreign");
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    const ownPrincipal = createOrganizationServicePrincipal({
      servicePrincipalId: "sp-own-1",
      tenantScope: ownTenantScope,
      workerRef: "worker-own-1",
    });
    const foreignPrincipal = createOrganizationServicePrincipal({
      servicePrincipalId: "sp-foreign-1",
      tenantScope: foreignTenantScope,
      workerRef: "worker-foreign-1",
    });
    store.create(ownPrincipal);
    store.create(foreignPrincipal);

    const source = createDurableWorkersRosterSource(store);
    const listed = source.listServicePrincipals(REVIEW_ORGANIZATION);
    assert.deepEqual(listed, [ownPrincipal]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N2-S6: createDurableWorkersRosterSource propagates a corrupted tenant file as a throw (never an empty list)", () => {
  const dir = freshDir();
  try {
    const tenantScope = createTenantScope(REVIEW_ORGANIZATION.tenantId);
    const store = new FileDurableOrganizationServicePrincipalStore(dir);
    store.create(
      createOrganizationServicePrincipal({ servicePrincipalId: "sp-corrupt-1", tenantScope, workerRef: "worker-corrupt-1" }),
    );
    const tenantFile = join(dir, `${Buffer.from(tenantScope.tenantId, "utf8").toString("base64url")}.json`);
    writeFileSync(tenantFile, "{ this is not json", "utf8");

    const source = createDurableWorkersRosterSource(store);
    assert.throws(() => source.listServicePrincipals(REVIEW_ORGANIZATION));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
