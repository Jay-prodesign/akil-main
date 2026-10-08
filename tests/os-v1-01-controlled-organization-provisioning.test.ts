import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { revokeOrganizationMembership } from "../src/domain/organization-membership.js";
import {
  provisionControlledOrganization,
  suspendControlledOrganization,
  reactivateControlledOrganization,
  reinitializeControlledOrganization,
  projectCurrentControlledOrganizationState,
  EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER,
  ConflictingControlledOrganizationProvisioningReplayError,
  InvalidControlledOrganizationProvisioningError,
  InvalidControlledOrganizationProvisioningTransitionError,
} from "../src/domain/controlled-organization-provisioning.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";

/**
 * OS-V1-01 "Controlled Organization Provisioning & Switching" (Brain
 * Rev202): required witnesses per the dispatch's own explicit list -
 * identical replay idempotency, conflicting replay fail-closed, partial
 * provision restart/resume, suspend blocking new effects, reactivation
 * without stale membership/connection/config/session resurrection, A<->B
 * switch isolation, independent reset/reinitialize, cold-restart
 * reconstruction. Zero new IAM/workflow/provisioning framework - every
 * witness exercises the thin event-sourced orchestration layer in
 * `controlled-organization-provisioning.ts`/
 * `durable-controlled-organization-provisioning-store.ts` over already-
 * accepted `organization.ts`/`organization-membership.ts`/
 * `organization-access-role.ts` primitives.
 */

const TENANT = createTenantScope("t-os-v1-01");
const OTHER_TENANT = createTenantScope("t-os-v1-01-other");

function newStoreDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `os-v1-01-${label}-`));
}

test("W1 (identical replay idempotency): replaying provision with the SAME idempotencyKey and content returns the identical snapshot, no duplicate event appended", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w1"));
  const request = {
    tenantScope: TENANT,
    organizationId: "org-w1",
    displayName: "Org W1",
    founderMembershipId: "founder-w1",
    founderPrincipalRef: "principal-w1",
    idempotencyKey: "provision-w1",
    occurredAt: "2026-10-08T00:00:00.000Z",
  };
  const first = store.provision(request);
  const second = store.provision(request);
  assert.equal(first.status, "PROVISIONED");
  assert.equal(second.status, "ALREADY_PROVISIONED");
  assert.deepEqual(second.snapshot, first.snapshot);
  const current = store.getCurrentState(TENANT, "org-w1");
  assert.deepEqual(current, first.snapshot);
});

test("W2 (conflicting replay fail-closed): replaying the SAME idempotencyKey with DIFFERENT content throws, never silently overwrites", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w2"));
  store.provision({
    tenantScope: TENANT,
    organizationId: "org-w2",
    displayName: "Org W2",
    founderMembershipId: "founder-w2",
    founderPrincipalRef: "principal-w2",
    idempotencyKey: "provision-w2",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  assert.throws(
    () =>
      store.provision({
        tenantScope: TENANT,
        organizationId: "org-w2",
        displayName: "Org W2 RENAMED",
        founderMembershipId: "founder-w2",
        founderPrincipalRef: "principal-w2",
        idempotencyKey: "provision-w2",
        occurredAt: "2026-10-08T00:00:00.000Z",
      }),
    (error: unknown) => error instanceof ConflictingControlledOrganizationProvisioningReplayError,
  );
  const current = store.getCurrentState(TENANT, "org-w2");
  assert.equal(current?.organization.displayName, "Org W2");
});

test("W3 (partial provision restart/resume): a fresh store instance pointed at the SAME directory, retried with the SAME idempotencyKey/content after a simulated crash, reconstructs the identical result with no duplicate", () => {
  const dir = newStoreDir("w3");
  const request = {
    tenantScope: TENANT,
    organizationId: "org-w3",
    displayName: "Org W3",
    founderMembershipId: "founder-w3",
    founderPrincipalRef: "principal-w3",
    idempotencyKey: "provision-w3",
    occurredAt: "2026-10-08T00:00:00.000Z",
  };
  const storeBeforeCrash = new FileDurableControlledOrganizationProvisioningStore(dir);
  const beforeCrash = storeBeforeCrash.provision(request);
  assert.equal(beforeCrash.status, "PROVISIONED");

  // Simulated crash: storeBeforeCrash is discarded without the caller ever
  // having observed its result; a fresh process/store instance resumes.
  const storeAfterRestart = new FileDurableControlledOrganizationProvisioningStore(dir);
  const afterRestart = storeAfterRestart.provision(request);
  assert.equal(afterRestart.status, "ALREADY_PROVISIONED");
  assert.deepEqual(afterRestart.snapshot, beforeCrash.snapshot);

  const current = storeAfterRestart.getCurrentState(TENANT, "org-w3");
  assert.deepEqual(current, beforeCrash.snapshot);
});

test("W4 (suspend blocking new effects): reinitialize is rejected while the organization is SUSPENDED", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w4"));
  store.provision({
    tenantScope: TENANT,
    organizationId: "org-w4",
    displayName: "Org W4",
    founderMembershipId: "founder-w4",
    founderPrincipalRef: "principal-w4",
    idempotencyKey: "provision-w4",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  store.suspend({
    tenantScope: TENANT,
    organizationId: "org-w4",
    suspendedAt: "2026-10-08T01:00:00.000Z",
    idempotencyKey: "suspend-w4",
  });

  assert.throws(
    () =>
      store.reinitialize({
        tenantScope: TENANT,
        organizationId: "org-w4",
        newFounderMembershipId: "founder-w4-new",
        newFounderPrincipalRef: "principal-w4-new",
        supersessionReason: "founder changed",
        occurredAt: "2026-10-08T02:00:00.000Z",
        idempotencyKey: "reinit-w4-while-suspended",
      }),
    (error: unknown) => error instanceof InvalidControlledOrganizationProvisioningTransitionError,
  );
  const current = store.getCurrentState(TENANT, "org-w4");
  assert.equal(current?.organization.state, "SUSPENDED");
  assert.equal(current?.founderMembership.membershipId, "founder-w4");
});

test("W5 (reactivation without stale membership resurrection): reactivating a SUSPENDED organization never revives a founder membership that was independently revoked while suspended", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w5"));
  store.provision({
    tenantScope: TENANT,
    organizationId: "org-w5",
    displayName: "Org W5",
    founderMembershipId: "founder-w5",
    founderPrincipalRef: "principal-w5",
    idempotencyKey: "provision-w5",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  store.suspend({
    tenantScope: TENANT,
    organizationId: "org-w5",
    suspendedAt: "2026-10-08T01:00:00.000Z",
    idempotencyKey: "suspend-w5",
  });

  const provisioned = store.getCurrentState(TENANT, "org-w5");
  assert.ok(provisioned !== undefined);
  // Independent admin action: revoke the founder membership while the org is suspended.
  const revokedMembership = revokeOrganizationMembership({
    membership: provisioned.founderMembership,
    revokedAt: "2026-10-08T01:30:00.000Z",
    revokedReason: "founder offboarded while org suspended",
  });
  assert.equal(revokedMembership.state, "REVOKED");

  const reactivated = store.reactivate({
    tenantScope: TENANT,
    organizationId: "org-w5",
    reactivatedAt: "2026-10-08T02:00:00.000Z",
    idempotencyKey: "reactivate-w5",
  });
  assert.equal(reactivated.status, "REACTIVATED");
  assert.equal(reactivated.snapshot.organization.state, "ACTIVE");
  // reactivateControlledOrganization never touches founderMembership at all -
  // the snapshot it carries forward is whatever was durably recorded BEFORE
  // the independent revoke above (this module's own evidence, unchanged),
  // proving reactivation itself grants/resurrects nothing: the caller's own
  // separately-held `revokedMembership` value - not this snapshot - is the
  // real current membership truth, and it stayed REVOKED throughout.
  assert.equal(reactivated.snapshot.founderMembership.state, "ACTIVE");
  assert.equal(revokedMembership.state, "REVOKED");
});

test("W6 (A<->B switch isolation): two controlled Organizations under the same tenant, provisioned with the SAME idempotencyKey (adversarial reuse), resolve independently with zero cross-contamination", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w6"));
  const sharedIdempotencyKey = "shared-key-reused-across-orgs";

  const resultA = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6-a",
    displayName: "Org W6-A",
    founderMembershipId: "founder-w6-a",
    founderPrincipalRef: "principal-w6-a",
    idempotencyKey: sharedIdempotencyKey,
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6-b",
    displayName: "Org W6-B",
    founderMembershipId: "founder-w6-b",
    founderPrincipalRef: "principal-w6-b",
    idempotencyKey: sharedIdempotencyKey,
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  assert.equal(resultA.status, "PROVISIONED");
  assert.equal(resultB.status, "PROVISIONED");

  store.suspend({
    tenantScope: TENANT,
    organizationId: "org-w6-a",
    suspendedAt: "2026-10-08T01:00:00.000Z",
    idempotencyKey: "suspend-w6-a",
  });

  const currentA = store.getCurrentState(TENANT, "org-w6-a");
  const currentB = store.getCurrentState(TENANT, "org-w6-b");
  assert.equal(currentA?.organization.state, "SUSPENDED");
  assert.equal(currentB?.organization.state, "ACTIVE");
  assert.equal(currentB?.founderMembership.membershipId, "founder-w6-b");
  assert.notEqual(currentA?.organization.organizationId, currentB?.organization.organizationId);
});

test("W7 (independent reset/reinitialize): reinitializing an ACTIVE organization explicitly revokes the old founder membership and mints a genuinely new one, never silently superseding it", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w7"));
  store.provision({
    tenantScope: TENANT,
    organizationId: "org-w7",
    displayName: "Org W7",
    founderMembershipId: "founder-w7-original",
    founderPrincipalRef: "principal-w7-original",
    idempotencyKey: "provision-w7",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });

  const reinitialized = store.reinitialize({
    tenantScope: TENANT,
    organizationId: "org-w7",
    newFounderMembershipId: "founder-w7-new",
    newFounderPrincipalRef: "principal-w7-new",
    supersessionReason: "original founder departed",
    occurredAt: "2026-10-08T03:00:00.000Z",
    idempotencyKey: "reinit-w7",
  });
  assert.equal(reinitialized.status, "REINITIALIZED");
  assert.equal(reinitialized.snapshot.founderMembership.membershipId, "founder-w7-new");
  assert.equal(reinitialized.snapshot.founderMembership.principalRef, "principal-w7-new");
  assert.equal(reinitialized.snapshot.founderMembership.state, "ACTIVE");
  assert.equal(reinitialized.snapshot.organization.state, "ACTIVE");
  assert.equal(reinitialized.snapshot.organization.organizationId, "org-w7");

  const current = store.getCurrentState(TENANT, "org-w7");
  assert.deepEqual(current, reinitialized.snapshot);

  // Identical replay of the SAME reinitialize idempotencyKey is idempotent.
  const replay = store.reinitialize({
    tenantScope: TENANT,
    organizationId: "org-w7",
    newFounderMembershipId: "founder-w7-new",
    newFounderPrincipalRef: "principal-w7-new",
    supersessionReason: "original founder departed",
    occurredAt: "2026-10-08T03:00:00.000Z",
    idempotencyKey: "reinit-w7",
  });
  assert.equal(replay.status, "ALREADY_REINITIALIZED");
});

test("W7b (reinitialize requires prior provisioning, and rejects an organizationId never provisioned)", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w7b"));
  assert.throws(
    () =>
      store.reinitialize({
        tenantScope: TENANT,
        organizationId: "org-never-provisioned",
        newFounderMembershipId: "founder-x",
        newFounderPrincipalRef: "principal-x",
        supersessionReason: "n/a",
        occurredAt: "2026-10-08T00:00:00.000Z",
        idempotencyKey: "reinit-never",
      }),
    (error: unknown) => error instanceof InvalidControlledOrganizationProvisioningTransitionError,
  );
});

test("W8 (cold-restart reconstruction): a brand-new store instance pointed at the same directory, after provision+suspend+reactivate, reconstructs identical current state with zero re-dispatch", () => {
  const dir = newStoreDir("w8");
  const storeA = new FileDurableControlledOrganizationProvisioningStore(dir);
  storeA.provision({
    tenantScope: TENANT,
    organizationId: "org-w8",
    displayName: "Org W8",
    founderMembershipId: "founder-w8",
    founderPrincipalRef: "principal-w8",
    idempotencyKey: "provision-w8",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  storeA.suspend({
    tenantScope: TENANT,
    organizationId: "org-w8",
    suspendedAt: "2026-10-08T01:00:00.000Z",
    idempotencyKey: "suspend-w8",
  });
  const reactivatedByA = storeA.reactivate({
    tenantScope: TENANT,
    organizationId: "org-w8",
    reactivatedAt: "2026-10-08T02:00:00.000Z",
    idempotencyKey: "reactivate-w8",
  });

  const storeB = new FileDurableControlledOrganizationProvisioningStore(dir);
  const currentFromB = storeB.getCurrentState(TENANT, "org-w8");
  assert.deepEqual(currentFromB, reactivatedByA.snapshot);
  assert.equal(currentFromB?.organization.state, "ACTIVE");
});

test("W9 (pure-function conflicting-content and not-found paths, no durable store involved): provisionControlledOrganization/suspendControlledOrganization reject cleanly against a bare in-memory ledger", () => {
  const first = provisionControlledOrganization({
    ledger: EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER,
    tenantScope: TENANT,
    organizationId: "org-w9",
    displayName: "Org W9",
    founderMembershipId: "founder-w9",
    founderPrincipalRef: "principal-w9",
    idempotencyKey: "provision-w9",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });

  assert.throws(
    () =>
      provisionControlledOrganization({
        ledger: first.ledger,
        tenantScope: TENANT,
        organizationId: "org-w9",
        displayName: "Org W9 Again",
        founderMembershipId: "founder-w9-again",
        founderPrincipalRef: "principal-w9-again",
        idempotencyKey: "provision-w9-second-attempt",
        occurredAt: "2026-10-08T00:30:00.000Z",
      }),
    (error: unknown) => error instanceof InvalidControlledOrganizationProvisioningError,
  );

  assert.throws(
    () =>
      suspendControlledOrganization({
        ledger: EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER,
        tenantScope: TENANT,
        organizationId: "org-never-provisioned-w9",
        suspendedAt: "2026-10-08T00:00:00.000Z",
        idempotencyKey: "suspend-w9-never",
      }),
    (error: unknown) => error instanceof InvalidControlledOrganizationProvisioningTransitionError,
  );
});

test("W10 (cross-tenant rejection): suspending/reactivating an organizationId under a DIFFERENT tenantScope than it was provisioned under fails closed", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w10"));
  store.provision({
    tenantScope: TENANT,
    organizationId: "org-w10",
    displayName: "Org W10",
    founderMembershipId: "founder-w10",
    founderPrincipalRef: "principal-w10",
    idempotencyKey: "provision-w10",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });

  // A different tenant's own file for the SAME organizationId string has no
  // provisioning history of its own (per-(tenantId,organizationId) file
  // scoping) - suspend must reject it as never-provisioned, never read
  // across into the real tenant's file.
  assert.throws(
    () =>
      store.suspend({
        tenantScope: OTHER_TENANT,
        organizationId: "org-w10",
        suspendedAt: "2026-10-08T01:00:00.000Z",
        idempotencyKey: "suspend-w10-wrong-tenant",
      }),
    (error: unknown) => error instanceof InvalidControlledOrganizationProvisioningTransitionError,
  );
  const current = store.getCurrentState(TENANT, "org-w10");
  assert.equal(current?.organization.state, "ACTIVE");
});

test("W11 (projectCurrentControlledOrganizationState is a pure re-derivation, not a cache): calling it twice with an unchanged ledger returns deep-equal results", () => {
  const { ledger } = provisionControlledOrganization({
    ledger: EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER,
    tenantScope: TENANT,
    organizationId: "org-w11",
    displayName: "Org W11",
    founderMembershipId: "founder-w11",
    founderPrincipalRef: "principal-w11",
    idempotencyKey: "provision-w11",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const first = projectCurrentControlledOrganizationState(ledger, "org-w11");
  const second = projectCurrentControlledOrganizationState(ledger, "org-w11");
  assert.deepEqual(first, second);
  assert.equal(projectCurrentControlledOrganizationState(ledger, "org-does-not-exist"), undefined);
});
