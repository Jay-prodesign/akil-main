import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createProject } from "../src/domain/project.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createOrganization, activateOrganization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createOrganizationResourceBinding, type OrganizationResourceBinding } from "../src/domain/organization-resource-binding.js";
import {
  FileDurableOrganizationResourceBindingStore,
  InvalidDurableOrganizationResourceBindingStoreError,
  CorruptedOrganizationResourceBindingLineError,
} from "../src/domain/durable-organization-resource-binding-store.js";

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "org-resource-binding-store-"));
}

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.jsonl`);
}

function bindingFixture(tenantSuffix = "a") {
  const tenantScope = createTenantScope(`tenant-store-org-${tenantSuffix}`);
  const customer = createCustomer({
    tenantScope,
    customerId: `cust-store-org-${tenantSuffix}`,
    displayName: "Org Customer",
  });
  const project = createProject({
    tenantScope,
    customer,
    projectId: `proj-store-org-${tenantSuffix}`,
    ownerRef: `owner-store-org-${tenantSuffix}`,
    state: "active",
  });
  const ownership = createProjectOwnershipRef({
    tenantId: tenantScope.tenantId,
    customerId: customer.customerId,
    projectId: project.projectId,
  });
  const organization = activateOrganization({
    organization: createOrganization({
      organizationId: `org_${tenantSuffix}`,
      tenantScope,
      displayName: "Org",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    activatedAt: "2026-01-01T00:05:00.000Z",
  });
  const membership = createOrganizationMembership({
    membershipId: `membership-${tenantSuffix}`,
    tenantScope,
    principalRef: `principal-${tenantSuffix}`,
    role: "STAFF",
  });
  const binding = createOrganizationResourceBinding({
    organization,
    memberships: [membership],
    project,
    ownership,
    boundAt: "2026-01-02T00:00:00.000Z",
  });
  return { tenantScope, organization, membership, project, ownership, binding };
}

test("D1: putIfAbsent creates a fresh binding once", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    const result = store.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    assert.equal(result.created, true);
    assert.deepEqual(result.binding, binding);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D2 (mandatory witness): repeated org bootstrap with the IDENTICAL binding is idempotent - created:false, no duplicate", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    const first = store.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    const second = store.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(second.binding, binding);
    const fileContent = readFileSync(tenantFilePath(dir, tenantScope.tenantId), "utf8");
    const lineCount = fileContent.split("\n").filter((line) => line.trim().length > 0).length;
    assert.equal(lineCount, 1, "a repeated identical bootstrap must never append a second durable line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D3 (mandatory witness): duplicate bootstrap with a DIFFERENT resource-binding record for the same organizationId fails closed - cannot duplicate or silently replace authority/resources", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, membership, project, ownership, binding } = bindingFixture();
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    store.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    const differentBinding = createOrganizationResourceBinding({
      organization,
      memberships: [membership],
      project,
      ownership,
      effectiveConfigRefs: ["cfg-added-later"],
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    assert.throws(
      () => store.putIfAbsent(tenantScope.tenantId, organization.organizationId, differentBinding),
      InvalidDurableOrganizationResourceBindingStoreError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D4 (mandatory witness): cold restart reconstructs the same binding truth from a fresh store instance pointed at the same baseDir", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    store.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);

    const restarted = new FileDurableOrganizationResourceBindingStore(dir);
    const reconstructed = restarted.get(tenantScope.tenantId, organization.organizationId);
    assert.deepEqual(reconstructed, binding);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D5: get() returns undefined for an organizationId never bootstrapped", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope } = bindingFixture();
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    assert.equal(store.get(tenantScope.tenantId, "org_never_bootstrapped"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D6: tenant isolation - a binding bootstrapped under tenant A is invisible to a query under tenant B", () => {
  const dir = freshStoreDir();
  try {
    const a = bindingFixture("iso-a");
    const b = bindingFixture("iso-b");
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    store.putIfAbsent(a.tenantScope.tenantId, a.organization.organizationId, a.binding);
    assert.equal(store.get(b.tenantScope.tenantId, a.organization.organizationId), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D7 (mandatory witness): the exact same store/constructors bootstrap a controlled second Organization with a different identifier under the same tenant, without disturbing the first", () => {
  const dir = freshStoreDir();
  try {
    const orgZero = bindingFixture("org_akilta");
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    store.putIfAbsent(orgZero.tenantScope.tenantId, orgZero.organization.organizationId, orgZero.binding);

    // A controlled second Organization under the SAME tenant, bootstrapped
    // through the identical putIfAbsent/createOrganizationResourceBinding
    // path with a different organizationId - no org_akilta-specific branch
    // exists anywhere in this store.
    const secondOrganization = activateOrganization({
      organization: createOrganization({
        organizationId: "org_controlled_second",
        tenantScope: orgZero.tenantScope,
        displayName: "Controlled Second Org",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      activatedAt: "2026-01-01T00:05:00.000Z",
    });
    const secondMembership = createOrganizationMembership({
      membershipId: "membership-second",
      tenantScope: orgZero.tenantScope,
      principalRef: "principal-second",
      role: "STAFF",
    });
    const secondBinding = createOrganizationResourceBinding({
      organization: secondOrganization,
      memberships: [secondMembership],
      project: orgZero.project,
      ownership: orgZero.ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    const result = store.putIfAbsent(orgZero.tenantScope.tenantId, secondOrganization.organizationId, secondBinding);
    assert.equal(result.created, true);

    assert.deepEqual(store.get(orgZero.tenantScope.tenantId, orgZero.organization.organizationId), orgZero.binding);
    assert.deepEqual(store.get(orgZero.tenantScope.tenantId, secondOrganization.organizationId), secondBinding);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D8: a corrupted persisted line (not valid JSON) fails closed with CorruptedOrganizationResourceBindingLineError", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope } = bindingFixture();
    mkdirSync(dir, { recursive: true });
    writeFileSync(tenantFilePath(dir, tenantScope.tenantId), "not-json\n", "utf8");
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    assert.throws(() => store.get(tenantScope.tenantId, "org_x"), CorruptedOrganizationResourceBindingLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D9: a persisted line claiming a different tenantId than the file it is stored under is rejected as cross-tenant contamination", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    mkdirSync(dir, { recursive: true });
    const contaminated = { ...binding, tenantId: "some-other-tenant" };
    writeFileSync(
      tenantFilePath(dir, tenantScope.tenantId),
      `${JSON.stringify({ organizationId: organization.organizationId, binding: contaminated })}\n`,
      "utf8",
    );
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    assert.throws(() => store.get(tenantScope.tenantId, organization.organizationId), CorruptedOrganizationResourceBindingLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
