import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../src/domain/project-ownership.js";
import { createConnectionRequirement, createSecretRef, type ConnectionRequirement } from "../src/domain/connection-authority.js";
import {
  createConnectorDescriptor,
  requestConnectorConnection,
  transitionConnectorConnection,
  type ConnectorDescriptor,
} from "../src/domain/integration-connector-catalog.js";
import {
  FileDurableConnectorConnectionStore,
  ConnectorConnectionVersionConflictError,
  CorruptedConnectorConnectionFileError,
} from "../src/domain/durable-connector-connection-store.js";

function tenantFilePath(dir: string, tenantId: string): string {
  const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
  return join(dir, `${safeKey}.json`);
}

function freshStoreDir(): string {
  return mkdtempSync(join(tmpdir(), "conn-001-connector-connection-store-"));
}

function ownership(tenantSuffix = "a"): ProjectOwnershipRef {
  return createProjectOwnershipRef({
    tenantId: `akilta-tenant-${tenantSuffix}`,
    customerId: `customer-${tenantSuffix}`,
    projectId: `project-${tenantSuffix}`,
  });
}

function githubDescriptor(): ConnectorDescriptor {
  return createConnectorDescriptor({
    connectorKind: "GITHUB",
    displayName: "GitHub",
    supportedAuthModes: ["OAUTH2"],
    capabilityRefs: ["cap:repo-access"],
    isAiModelProvider: false,
    requiresOAuthRedirect: true,
  });
}

function requirementFor(descriptor: ConnectorDescriptor, ownershipRef: ProjectOwnershipRef): ConnectionRequirement {
  return createConnectionRequirement({
    connectionRequirementId: `req-${descriptor.connectorKind}-${ownershipRef.tenantId}`,
    ownership: ownershipRef,
    requiredCapabilityRef: descriptor.capabilityRefs[0] as string,
    purpose: "test purpose",
    accountOwner: "AKILTA_MANAGED",
    minimumProviderScope: [],
    connectionMethod: "api",
    validationRequirement: "must respond 200",
  });
}

test("M1: save() with no existing record and no expectedVersion creates at version 1", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });

    const stored = store.save(instance);
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.instance, instance);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M2 (adversarial): save() rejects an expectedVersion when no record exists yet", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });

    assert.throws(() => store.save(instance, 1), ConnectorConnectionVersionConflictError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M3: save() with the correct expectedVersion updates the record and increments the version by exactly 1", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    const created = store.save(instance);

    const unverified = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
    const updated = store.save(unverified, created.version);
    assert.equal(updated.version, 2);
    assert.equal(updated.instance.binding.connectionState, "CONNECTED_UNVERIFIED");
    assert.deepEqual(
      store.get(requirement.ownership.tenantId, instance.binding.connectionBindingId),
      updated,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M4 (adversarial, lost-update prevention): save() rejects an update with a missing or stale expectedVersion once a record exists", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    store.save(instance);
    const unverified = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");

    // no expectedVersion at all - blind overwrite is rejected
    assert.throws(() => store.save(unverified), ConnectorConnectionVersionConflictError);
    // stale expectedVersion (simulating a lost race against a concurrent writer)
    assert.throws(() => store.save(unverified, 99), ConnectorConnectionVersionConflictError);

    // the record on disk is untouched by either rejected attempt
    const stillOriginal = store.get(requirement.ownership.tenantId, instance.binding.connectionBindingId);
    assert.equal(stillOriginal?.version, 1);
    assert.equal(stillOriginal?.instance.binding.connectionState, "REQUESTED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M5: get() returns undefined for an unknown connectionBindingId, and for a wrong tenantId (cross-tenant isolation)", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirementA = requirementFor(descriptor, ownership("a"));
    const instanceA = requestConnectorConnection({
      requirement: requirementA,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    store.save(instanceA);

    const requirementB = requirementFor(descriptor, ownership("b"));
    const instanceB = requestConnectorConnection({
      requirement: requirementB,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-unknown",
      workspaceRef: "workspace-b",
      integrationInstanceRef: "instance-b",
      delegatedScope: [],
      authMode: "OAUTH2",
    });

    assert.equal(
      store.get(requirementA.ownership.tenantId, instanceB.binding.connectionBindingId),
      undefined,
    );
    assert.equal(
      store.get(requirementB.ownership.tenantId, instanceA.binding.connectionBindingId),
      undefined,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6 (cross-tenant isolation): list() for one tenant never includes another tenant's connections", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();

    const requirementA = requirementFor(descriptor, ownership("a"));
    const instanceA = requestConnectorConnection({
      requirement: requirementA,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-a",
      workspaceRef: "workspace-a",
      integrationInstanceRef: "instance-a",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    store.save(instanceA);

    const requirementB = requirementFor(descriptor, ownership("b"));
    const instanceB = requestConnectorConnection({
      requirement: requirementB,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-b",
      workspaceRef: "workspace-b",
      integrationInstanceRef: "instance-b",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    store.save(instanceB);

    const listedA = store.list(requirementA.ownership.tenantId);
    assert.equal(listedA.length, 1);
    assert.equal(listedA[0]?.instance.binding.connectionBindingId, instanceA.binding.connectionBindingId);

    const listedB = store.list(requirementB.ownership.tenantId);
    assert.equal(listedB.length, 1);
    assert.equal(listedB[0]?.instance.binding.connectionBindingId, instanceB.binding.connectionBindingId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M7 (restart-safety): a fresh store instance over the same baseDir reconstructs the identical stored record, including its version", () => {
  const dir = freshStoreDir();
  try {
    const storeA = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    const created = storeA.save(instance);
    const unverified = transitionConnectorConnection(instance, "CONNECTED_UNVERIFIED");
    const updated = storeA.save(unverified, created.version);

    const storeB = new FileDurableConnectorConnectionStore(dir);
    const reloaded = storeB.get(requirement.ownership.tenantId, instance.binding.connectionBindingId);
    assert.deepEqual(reloaded, updated);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Rev94 F2: fail-closed replay validation - forged/corrupt on-disk records
// ---------------------------------------------------------------------------

test("M8 (adversarial replay): a forged file that is not valid JSON fails closed on read", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const requirement = requirementFor(githubDescriptor(), ownership());
    writeFileSync(tenantFilePath(dir, requirement.ownership.tenantId), "{ not valid json", "utf8");
    assert.throws(() => store.list(requirement.ownership.tenantId), CorruptedConnectorConnectionFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M9 (adversarial replay): a forged file that is a bare JSON array (not an object keyed by connectionBindingId) fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const requirement = requirementFor(githubDescriptor(), ownership());
    writeFileSync(tenantFilePath(dir, requirement.ownership.tenantId), "[]", "utf8");
    assert.throws(() => store.list(requirement.ownership.tenantId), CorruptedConnectorConnectionFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M10 (adversarial replay): a forged record whose stored key does not match its embedded instance.binding.connectionBindingId fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    const stored = store.save(instance);
    const forgedFile = {
      "bind-DIFFERENT-KEY": { instance, version: stored.version },
    };
    writeFileSync(tenantFilePath(dir, requirement.ownership.tenantId), JSON.stringify(forgedFile), "utf8");
    assert.throws(() => store.list(requirement.ownership.tenantId), CorruptedConnectorConnectionFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M11 (adversarial replay): a forged record claiming a foreign tenant's ownership.tenantId under this tenant's file fails closed (cross-tenant contamination)", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirementA = requirementFor(descriptor, ownership("a"));
    const instanceA = requestConnectorConnection({
      requirement: requirementA,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-a",
      workspaceRef: "workspace-a",
      integrationInstanceRef: "instance-a",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    const storedA = store.save(instanceA);

    // Forge tenant A's file to contain a record whose embedded
    // ownership.tenantId is actually tenant B's - simulating either file
    // corruption or an attempted cross-tenant injection.
    const requirementB = requirementFor(descriptor, ownership("b"));
    const instanceBUnderTenantAFile = requestConnectorConnection({
      requirement: requirementB,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-a",
      workspaceRef: "workspace-b-forged",
      integrationInstanceRef: "instance-b-forged",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    const forgedFile = {
      "bind-a": { instance: instanceBUnderTenantAFile, version: storedA.version },
    };
    writeFileSync(tenantFilePath(dir, requirementA.ownership.tenantId), JSON.stringify(forgedFile), "utf8");

    assert.throws(() => store.list(requirementA.ownership.tenantId), CorruptedConnectorConnectionFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12 (adversarial replay): a forged record with an unrecognized connectorKind fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    const stored = store.save(instance);
    const forgedInstance = { ...instance, connectorKind: "NOT_A_REAL_CONNECTOR" };
    const forgedFile = { "bind-1": { instance: forgedInstance, version: stored.version } };
    writeFileSync(tenantFilePath(dir, requirement.ownership.tenantId), JSON.stringify(forgedFile), "utf8");

    assert.throws(() => store.list(requirement.ownership.tenantId), CorruptedConnectorConnectionFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M13 (adversarial replay): a forged record whose binding.providerRef does not match instance.connectorKind fails closed", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    const stored = store.save(instance);
    const forgedInstance = {
      ...instance,
      binding: { ...instance.binding, providerRef: "OPENAI" },
    };
    const forgedFile = { "bind-1": { instance: forgedInstance, version: stored.version } };
    writeFileSync(tenantFilePath(dir, requirement.ownership.tenantId), JSON.stringify(forgedFile), "utf8");

    assert.throws(() => store.list(requirement.ownership.tenantId), CorruptedConnectorConnectionFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M14 (adversarial replay): a forged record whose secretRef is an object (not a plain opaque string) fails closed - structural secret boundary", () => {
  const dir = freshStoreDir();
  try {
    const store = new FileDurableConnectorConnectionStore(dir);
    const descriptor = githubDescriptor();
    const requirement = requirementFor(descriptor, ownership());
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-1",
      workspaceRef: "workspace-1",
      integrationInstanceRef: "instance-1",
      delegatedScope: [],
      authMode: "OAUTH2",
    });
    const stored = store.save(instance);
    const forgedInstance = {
      ...instance,
      binding: { ...instance.binding, secretRef: { raw: "sk-live-forged-secret-value" } },
    };
    const forgedFile = { "bind-1": { instance: forgedInstance, version: stored.version } };
    writeFileSync(tenantFilePath(dir, requirement.ownership.tenantId), JSON.stringify(forgedFile), "utf8");

    assert.throws(() => store.list(requirement.ownership.tenantId), CorruptedConnectorConnectionFileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M15 (positive replay): legitimate persisted state with every field populated (serviceRef, secretRef, verificationEvidenceRef) still reconstructs correctly after restart", () => {
  const dir = freshStoreDir();
  try {
    const descriptor = githubDescriptor();
    const ownershipRef = createProjectOwnershipRef({
      tenantId: "akilta-tenant-full",
      customerId: "customer-full",
      projectId: "project-full",
      serviceRef: "service-full",
    });
    const requirement = requirementFor(descriptor, ownershipRef);
    const instance = requestConnectorConnection({
      requirement,
      connectorDescriptor: descriptor,
      connectionBindingId: "bind-full",
      workspaceRef: "workspace-full",
      integrationInstanceRef: "instance-full",
      delegatedScope: [],
      authMode: "OAUTH2",
      secretRef: createSecretRef({ secretRefId: "secret-ref-full" }),
    });
    const storeA = new FileDurableConnectorConnectionStore(dir);
    storeA.save(instance);

    const storeB = new FileDurableConnectorConnectionStore(dir);
    const reloaded = storeB.get(requirement.ownership.tenantId, instance.binding.connectionBindingId);
    assert.deepEqual(reloaded?.instance, instance);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
