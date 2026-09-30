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
  bootstrapOrganizationResourceBinding,
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

function writeRawRecord(dir: string, tenantScope: ReturnType<typeof createTenantScope>, organizationId: string, binding: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    tenantFilePath(dir, tenantScope.tenantId),
    `${JSON.stringify({ organizationId, binding })}\n`,
    "utf8",
  );
}

test("D10 (Rev183 F4 mandatory witness): a persisted line with an empty membershipRefs array is rejected - construction itself could never produce this state", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    writeRawRecord(dir, tenantScope, organization.organizationId, { ...binding, membershipRefs: [] });
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    assert.throws(() => store.get(tenantScope.tenantId, organization.organizationId), CorruptedOrganizationResourceBindingLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D11 (Rev183 F4 mandatory witness): a persisted line with a duplicate entry inside a ref array is rejected, exactly like duplicate rejection at construction", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    writeRawRecord(dir, tenantScope, organization.organizationId, {
      ...binding,
      connectionBindingRefs: ["conn-1", "conn-1"],
    });
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    assert.throws(() => store.get(tenantScope.tenantId, organization.organizationId), CorruptedOrganizationResourceBindingLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D12 (Rev183 F4 mandatory witness): a persisted line with a leading/trailing-whitespace ref is rejected, exactly like the domain's own whitespace invariant at construction", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    writeRawRecord(dir, tenantScope, organization.organizationId, {
      ...binding,
      effectiveConfigRefs: [" cfg-padded "],
    });
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    assert.throws(() => store.get(tenantScope.tenantId, organization.organizationId), CorruptedOrganizationResourceBindingLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D13 (Rev183 F4 mandatory witness): a persisted line whose top-level projectRef disagrees with binding.ownership.projectId is rejected - construction requires them to agree", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    writeRawRecord(dir, tenantScope, organization.organizationId, {
      ...binding,
      projectRef: "a-different-project-id",
    });
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    assert.throws(() => store.get(tenantScope.tenantId, organization.organizationId), CorruptedOrganizationResourceBindingLineError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function creationLockPathFor(dir: string, tenantId: string, organizationId: string): string {
  const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
  const orgKey = Buffer.from(organizationId, "utf8").toString("base64url");
  return join(dir, ".creation-locks", `${tenantKey}.${orgKey}.lock`);
}

test("D14 (Rev183 F2 mandatory witness): partial-failure/restart recovery - a creation-lock left behind by a writer that crashed before its own durable append is self-healed by the next putIfAbsent call, rather than permanently hiding the record from get()", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, binding } = bindingFixture();
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    // Simulate a crash that happened AFTER a prior writer's linkSync won the
    // creation-lock race but BEFORE its own appendFileSync to the durable
    // per-tenant .jsonl file ever ran: write the lock file directly,
    // bypassing putIfAbsent's own append step entirely, and never touch the
    // .jsonl file.
    const lockPath = creationLockPathFor(dir, tenantScope.tenantId, organization.organizationId);
    writeFileSync(lockPath, JSON.stringify({ organizationId: organization.organizationId, binding }), "utf8");

    // Before self-heal: the record is invisible to get() even though the
    // lock durably exists.
    assert.equal(store.get(tenantScope.tenantId, organization.organizationId), undefined);

    const result = store.putIfAbsent(tenantScope.tenantId, organization.organizationId, binding);
    assert.equal(result.created, false, "the lock already existed - this call did not win creation, it recovered it");
    assert.deepEqual(result.binding, binding);

    // After self-heal: get() now durably resolves the binding.
    assert.deepEqual(store.get(tenantScope.tenantId, organization.organizationId), binding);
    const fileContent = readFileSync(tenantFilePath(dir, tenantScope.tenantId), "utf8");
    const lineCount = fileContent.split("\n").filter((line) => line.trim().length > 0).length;
    assert.equal(lineCount, 1, "self-heal must durably record exactly one line, not zero and not a duplicate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D15 (Rev183 F2 mandatory witness): bootstrapOrganizationResourceBinding composes create+persist for ANY organizationId, idempotently, with no org_akilta-specific branch", () => {
  const dir = freshStoreDir();
  try {
    const { tenantScope, organization, membership, project, ownership } = bindingFixture();
    const store = new FileDurableOrganizationResourceBindingStore(dir);
    const first = bootstrapOrganizationResourceBinding({
      store,
      organization,
      memberships: [membership],
      project,
      ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    assert.equal(first.created, true);

    const second = bootstrapOrganizationResourceBinding({
      store,
      organization,
      memberships: [membership],
      project,
      ownership,
      boundAt: "2026-01-02T00:00:00.000Z",
    });
    assert.equal(second.created, false, "the same real evidence must reinitialize deterministically and idempotently");
    assert.deepEqual(second.binding, first.binding);
    assert.deepEqual(store.get(tenantScope.tenantId, organization.organizationId), first.binding);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
