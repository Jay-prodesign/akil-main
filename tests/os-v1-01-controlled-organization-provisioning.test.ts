import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope, type TenantScope } from "../src/domain/tenant-scope.js";
import {
  createOrganizationMembership,
  revokeOrganizationMembership,
  createAssignmentReference,
} from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import {
  provisionControlledOrganization,
  suspendControlledOrganization,
  reinitializeControlledOrganization,
  resolveControlledOrganizationSwitch,
  projectCurrentControlledOrganizationState,
  EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER,
  ConflictingControlledOrganizationProvisioningReplayError,
  InvalidControlledOrganizationProvisioningError,
  InvalidControlledOrganizationProvisioningTransitionError,
  type ControlledOrganizationProvisioningLedger,
} from "../src/domain/controlled-organization-provisioning.js";
import { FileDurableControlledOrganizationProvisioningStore } from "../src/domain/durable-controlled-organization-provisioning-store.js";

/**
 * OS-V1-01 "Controlled Organization Provisioning & Switching" (Brain
 * Rev202, corrected per Rev203 F1-F4): required witnesses - identical
 * replay idempotency, conflicting replay fail-closed, partial provision
 * restart/resume (genuine intermediate-failure recovery, distinct from
 * response-loss replay), suspend blocking new effects, reactivation
 * without stale membership/connection/config/session resurrection, A<->B
 * switch isolation (storage AND server-authoritative admission),
 * independent reset/reinitialize, cold-restart reconstruction, plus the
 * F1 baseline-composition and F2 switch-admission witnesses Rev203 itself
 * added.
 */

const TENANT = createTenantScope("t-os-v1-01");
const OTHER_TENANT = createTenantScope("t-os-v1-01-other");

function newStoreDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `os-v1-01-${label}-`));
}

/** Rev204 F2-R1: a minimum READ-only authority context - the switch check's own "minimum existing READ authority" requirement. */
function readAuthority() {
  return createAuthorityContext({ tenantScope: TENANT, permissions: ["READ"], canPerformProtectedActions: false });
}

/** An authority context deliberately lacking READ, for the "insufficient authority" denial witness. */
function noPermissionsAuthority() {
  return createAuthorityContext({ tenantScope: TENANT, permissions: [], canPerformProtectedActions: false });
}

/** Rev203 F4: injects a deterministic crash point between pure computation and durable persistence, exactly once, then allows the retry through - exercising `writeLedger`'s `protected` seam. */
class CrashOnFirstWriteStore extends FileDurableControlledOrganizationProvisioningStore {
  private hasThrown = false;

  protected writeLedger(
    tenantId: TenantScope["tenantId"],
    organizationId: string,
    ledger: ControlledOrganizationProvisioningLedger,
  ): void {
    if (!this.hasThrown) {
      this.hasThrown = true;
      throw new Error("W3b: simulated crash between pure computation and durable persistence");
    }
    super.writeLedger(tenantId, organizationId, ledger);
  }
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

test("W3 (response-loss replay - a fresh store instance after the caller never observed a successful result, NOT the intermediate-failure crash witness - see W3b): reconstructs the identical result with no duplicate", () => {
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

  const storeAfterRestart = new FileDurableControlledOrganizationProvisioningStore(dir);
  const afterRestart = storeAfterRestart.provision(request);
  assert.equal(afterRestart.status, "ALREADY_PROVISIONED");
  assert.deepEqual(afterRestart.snapshot, beforeCrash.snapshot);
});

test("W3b (Rev203 F4 - genuine partial-provision intermediate-failure/restart-resume): a deterministic crash BETWEEN pure computation and durable persistence leaves zero durable effect; retrying with the same inputs completes exactly once with no duplicate resources/authority", () => {
  const dir = newStoreDir("w3b");
  const request = {
    tenantScope: TENANT,
    organizationId: "org-w3b",
    displayName: "Org W3b",
    founderMembershipId: "founder-w3b",
    founderPrincipalRef: "principal-w3b",
    idempotencyKey: "provision-w3b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  };
  const crashStore = new CrashOnFirstWriteStore(dir);
  assert.throws(() => crashStore.provision(request), /simulated crash/);

  // Zero durable effect from the crashed attempt - a fresh plain store at
  // the same directory sees no provisioning history at all yet.
  const freshAfterCrash = new FileDurableControlledOrganizationProvisioningStore(dir);
  assert.equal(freshAfterCrash.getCurrentState(TENANT, "org-w3b"), undefined);

  // Retry (second call on the SAME crash-instrumented store - its own
  // internal "has thrown once" flag now lets the write through) completes
  // for real, exactly once.
  const resumed = crashStore.provision(request);
  assert.equal(resumed.status, "PROVISIONED");
  const afterResume = freshAfterCrash.getCurrentState(TENANT, "org-w3b");
  assert.deepEqual(afterResume, resumed.snapshot);
  assert.equal(afterResume?.resourceBinding.membershipRefs.length, 1);
});

test("W4 (suspend blocking new effects): reinitialize is rejected while the organization is SUSPENDED", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w4"));
  const provisioned = store.provision({
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
        currentFounderMembership: provisioned.mintedFounderMembership!,
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
  assert.equal(current?.founderMembershipId, "founder-w4");
});

test("W5 (reactivation without stale membership resurrection): the snapshot structurally never claims a live membership state, and switch-admission re-resolved AFTER reactivation still denies a membership independently revoked while suspended", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w5"));
  const provisioned = store.provision({
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

  // Independent admin action: revoke the founder membership while the org is suspended.
  const revokedMembership = revokeOrganizationMembership({
    membership: provisioned.mintedFounderMembership!,
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
  // The snapshot carries no membership STATE claim at all - only the ref -
  // so there is structurally nothing here that could be "stale ACTIVE."
  assert.equal((reactivated.snapshot as unknown as Record<string, unknown>)["founderMembership"], undefined);
  assert.equal(reactivated.snapshot.founderMembershipId, revokedMembership.membershipId);

  // The genuine currentness check, re-resolved fresh with the CALLER's own
  // current (revoked) membership evidence, correctly denies - now at the
  // Rev204 F2-R1 access-resolution layer itself (membership currentness is
  // checked before principalRef/assignment), never reaching the binding gate.
  const switchResult = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w5",
    currentMembership: revokedMembership,
    currentPrincipalRef: revokedMembership.principalRef,
    authority: readAuthority(),
  });
  assert.equal(switchResult.state, "BLOCKED");
  assert.equal(switchResult.unresolvedGates[0], "EFFECTIVE_ACCESS_DENIED");
});

test("W6 (A<->B switch isolation - storage): two controlled Organizations under the same tenant, provisioned with the SAME idempotencyKey (adversarial reuse), resolve independently with zero cross-contamination", () => {
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
  assert.equal(currentB?.founderMembershipId, "founder-w6-b");
  assert.notEqual(currentA?.organization.organizationId, currentB?.organization.organizationId);
});

test("W6b-1 (Rev204 F2-R1 - valid B founder: correct membership, correct principal, current project assignment, sufficient authority => READY)", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w6b1"));
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6b1-b",
    displayName: "Org W6b1-B",
    founderMembershipId: "founder-w6b1-b",
    founderPrincipalRef: "principal-w6b1-b",
    idempotencyKey: "provision-w6b1-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipB = resultB.mintedFounderMembership!;
  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-w6b1-b",
    membership: membershipB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });

  const validSwitch = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w6b1-b",
    currentMembership: membershipB,
    currentPrincipalRef: membershipB.principalRef,
    authority: readAuthority(),
    assignments: [assignmentB],
  });
  assert.equal(validSwitch.state, "READY");
  assert.equal(validSwitch.nextRequiredActor, "NONE");
});

test("W6b-2 (Rev204 F2-R1 - A's own principal presenting B's real, correctly-bound membership OBJECT ('stolen membership') is denied at the access layer, never reaching the binding gate)", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w6b2"));
  store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6b2-a",
    displayName: "Org W6b2-A",
    founderMembershipId: "founder-w6b2-a",
    founderPrincipalRef: "principal-w6b2-a",
    idempotencyKey: "provision-w6b2-a",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6b2-b",
    displayName: "Org W6b2-B",
    founderMembershipId: "founder-w6b2-b",
    founderPrincipalRef: "principal-w6b2-b",
    idempotencyKey: "provision-w6b2-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipB = resultB.mintedFounderMembership!;
  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-w6b2-b",
    membership: membershipB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });

  // The caller asserts A's own principal identity, but presents B's real,
  // currently-ACTIVE, correctly-bound membership OBJECT (e.g. leaked/stolen
  // in transit). The exact membership.principalRef === currentPrincipalRef
  // equality in resolveEffectiveOrganizationAccess catches this - a
  // binding-isolation check alone (W6) never would, since the membership
  // object itself really is bound to B.
  const stolenSwitch = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w6b2-b",
    currentMembership: membershipB,
    currentPrincipalRef: "principal-w6b2-a",
    authority: readAuthority(),
    assignments: [assignmentB],
  });
  assert.equal(stolenSwitch.state, "BLOCKED");
  assert.equal(stolenSwitch.unresolvedGates[0], "EFFECTIVE_ACCESS_DENIED");
  assert.equal(
    stolenSwitch.nextRequiredAction?.reason,
    "membership belongs to a different principal than the current caller identity",
  );
});

test("W6b-3 (Rev204 F2-R1 - same real-world principal holding SEPARATE memberships in A and B: the A-bound membership still fails closed against B even with a matching principal; only the B-bound membership, with B's own current assignment, succeeds)", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w6b3"));
  const sharedPrincipal = "principal-w6b3-shared";
  const resultA = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6b3-a",
    displayName: "Org W6b3-A",
    founderMembershipId: "founder-w6b3-a",
    founderPrincipalRef: sharedPrincipal,
    idempotencyKey: "provision-w6b3-a",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6b3-b",
    displayName: "Org W6b3-B",
    founderMembershipId: "founder-w6b3-b",
    founderPrincipalRef: sharedPrincipal,
    idempotencyKey: "provision-w6b3-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipA = resultA.mintedFounderMembership!;
  const membershipB = resultB.mintedFounderMembership!;

  const assignmentAAgainstB = createAssignmentReference({
    assignmentId: "assignment-w6b3-a-against-b",
    membership: membershipA,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });
  const aAgainstB = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w6b3-b",
    currentMembership: membershipA,
    currentPrincipalRef: sharedPrincipal,
    authority: readAuthority(),
    assignments: [assignmentAAgainstB],
  });
  assert.equal(aAgainstB.state, "BLOCKED");
  assert.equal(aAgainstB.unresolvedGates[0], "NO_ACTIVE_BOUND_MEMBERSHIP");

  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-w6b3-b",
    membership: membershipB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });
  const bAgainstB = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w6b3-b",
    currentMembership: membershipB,
    currentPrincipalRef: sharedPrincipal,
    authority: readAuthority(),
    assignments: [assignmentB],
  });
  assert.equal(bAgainstB.state, "READY");
});

test("W6b-4 (Rev204 F2-R1 - a revoked B founder membership is denied at the access layer, never reaching the binding gate)", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w6b4"));
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6b4-b",
    displayName: "Org W6b4-B",
    founderMembershipId: "founder-w6b4-b",
    founderPrincipalRef: "principal-w6b4-b",
    idempotencyKey: "provision-w6b4-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const revokedB = revokeOrganizationMembership({
    membership: resultB.mintedFounderMembership!,
    revokedAt: "2026-10-08T01:00:00.000Z",
    revokedReason: "founder offboarded",
  });
  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-w6b4-b",
    membership: revokedB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });
  const revokedSwitch = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w6b4-b",
    currentMembership: revokedB,
    currentPrincipalRef: revokedB.principalRef,
    authority: readAuthority(),
    assignments: [assignmentB],
  });
  assert.equal(revokedSwitch.state, "BLOCKED");
  assert.equal(revokedSwitch.unresolvedGates[0], "EFFECTIVE_ACCESS_DENIED");
  assert.equal(
    revokedSwitch.nextRequiredAction?.reason,
    "membership is not an active, coherent membership record",
  );
});

test("W6b-5 (Rev204 F2-R1 - a valid, correctly-bound, correct-principal B membership with NO current project assignment evidence is denied at the access layer)", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w6b5"));
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6b5-b",
    displayName: "Org W6b5-B",
    founderMembershipId: "founder-w6b5-b",
    founderPrincipalRef: "principal-w6b5-b",
    idempotencyKey: "provision-w6b5-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipB = resultB.mintedFounderMembership!;

  // No assignments supplied at all - resolveAssignmentStatus defaults an
  // omitted/empty evidence list to UNASSIGNED, failing closed exactly like
  // a missing membership does.
  const staleSwitch = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w6b5-b",
    currentMembership: membershipB,
    currentPrincipalRef: membershipB.principalRef,
    authority: readAuthority(),
  });
  assert.equal(staleSwitch.state, "BLOCKED");
  assert.equal(staleSwitch.unresolvedGates[0], "EFFECTIVE_ACCESS_DENIED");
  assert.equal(
    staleSwitch.nextRequiredAction?.reason,
    "no exact assignment evidence exists for the current membership and project scope",
  );
});

test("W6b-6 (Rev204 F2-R1 - a valid, correctly-bound, correctly-assigned B founder WITHOUT READ authority is denied as insufficient authority, a distinct gate from the access-layer denial)", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w6b6"));
  const resultB = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6b6-b",
    displayName: "Org W6b6-B",
    founderMembershipId: "founder-w6b6-b",
    founderPrincipalRef: "principal-w6b6-b",
    idempotencyKey: "provision-w6b6-b",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membershipB = resultB.mintedFounderMembership!;
  const assignmentB = createAssignmentReference({
    assignmentId: "assignment-w6b6-b",
    membership: membershipB,
    customerId: resultB.snapshot.project.customerId,
    projectId: resultB.snapshot.project.projectId,
  });

  const insufficientSwitch = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w6b6-b",
    currentMembership: membershipB,
    currentPrincipalRef: membershipB.principalRef,
    authority: noPermissionsAuthority(),
    assignments: [assignmentB],
  });
  assert.equal(insufficientSwitch.state, "BLOCKED");
  assert.equal(insufficientSwitch.unresolvedGates[0], "INSUFFICIENT_AUTHORITY");
});

test("W6c (switch admission denies a SUSPENDED target organization): resolveControlledOrganizationSwitch reuses resolveOrganizationResourceBindingStatus's own ORGANIZATION_SUSPENDED gate - reached only AFTER the caller passes the Rev204 F2-R1 access-layer pre-gate", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w6c"));
  const provisioned = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w6c",
    displayName: "Org W6c",
    founderMembershipId: "founder-w6c",
    founderPrincipalRef: "principal-w6c",
    idempotencyKey: "provision-w6c",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const membership = provisioned.mintedFounderMembership!;
  const assignment = createAssignmentReference({
    assignmentId: "assignment-w6c",
    membership,
    customerId: provisioned.snapshot.project.customerId,
    projectId: provisioned.snapshot.project.projectId,
  });
  store.suspend({
    tenantScope: TENANT,
    organizationId: "org-w6c",
    suspendedAt: "2026-10-08T01:00:00.000Z",
    idempotencyKey: "suspend-w6c",
  });
  const result = store.resolveSwitch({
    tenantScope: TENANT,
    organizationId: "org-w6c",
    currentMembership: membership,
    currentPrincipalRef: membership.principalRef,
    authority: readAuthority(),
    assignments: [assignment],
  });
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.unresolvedGates[0], "ORGANIZATION_SUSPENDED");
});

test("W7 (independent reset/reinitialize): reinitializing an ACTIVE organization explicitly revokes the old founder membership and mints a genuinely new one, never silently superseding it", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w7"));
  const provisioned = store.provision({
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
    currentFounderMembership: provisioned.mintedFounderMembership!,
    newFounderMembershipId: "founder-w7-new",
    newFounderPrincipalRef: "principal-w7-new",
    supersessionReason: "original founder departed",
    occurredAt: "2026-10-08T03:00:00.000Z",
    idempotencyKey: "reinit-w7",
  });
  assert.equal(reinitialized.status, "REINITIALIZED");
  assert.equal(reinitialized.snapshot.founderMembershipId, "founder-w7-new");
  assert.equal(reinitialized.mintedFounderMembership?.principalRef, "principal-w7-new");
  assert.equal(reinitialized.snapshot.organization.state, "ACTIVE");
  assert.equal(reinitialized.snapshot.organization.organizationId, "org-w7");
  // The old founder is no longer bound in the NEW resource binding.
  assert.ok(!reinitialized.snapshot.resourceBinding.membershipRefs.includes("founder-w7-original" as never));
  assert.ok(reinitialized.snapshot.resourceBinding.membershipRefs.includes("founder-w7-new" as never));

  const current = store.getCurrentState(TENANT, "org-w7");
  assert.deepEqual(current, reinitialized.snapshot);

  const replay = store.reinitialize({
    tenantScope: TENANT,
    organizationId: "org-w7",
    currentFounderMembership: provisioned.mintedFounderMembership!,
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
  const throwawayMembership = createOrganizationMembership({
    membershipId: "throwaway",
    tenantScope: TENANT,
    principalRef: "throwaway-principal",
    role: "STAFF",
  });
  assert.throws(
    () =>
      store.reinitialize({
        tenantScope: TENANT,
        organizationId: "org-never-provisioned",
        currentFounderMembership: throwawayMembership,
        newFounderMembershipId: "founder-x",
        newFounderPrincipalRef: "principal-x",
        supersessionReason: "n/a",
        occurredAt: "2026-10-08T00:00:00.000Z",
        idempotencyKey: "reinit-never",
      }),
    (error: unknown) => error instanceof InvalidControlledOrganizationProvisioningTransitionError,
  );
});

test("W7c (reinitialize rejects a currentFounderMembership that does not match the organization's own current founderMembershipId): closes substitution of a foreign/stale membership into the revoke step", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w7c"));
  store.provision({
    tenantScope: TENANT,
    organizationId: "org-w7c",
    displayName: "Org W7c",
    founderMembershipId: "founder-w7c",
    founderPrincipalRef: "principal-w7c",
    idempotencyKey: "provision-w7c",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const foreignMembership = createOrganizationMembership({
    membershipId: "founder-of-a-different-org",
    tenantScope: TENANT,
    principalRef: "someone-else",
    role: "STAFF",
  });
  assert.throws(
    () =>
      store.reinitialize({
        tenantScope: TENANT,
        organizationId: "org-w7c",
        currentFounderMembership: foreignMembership,
        newFounderMembershipId: "founder-w7c-new",
        newFounderPrincipalRef: "principal-w7c-new",
        supersessionReason: "n/a",
        occurredAt: "2026-10-08T01:00:00.000Z",
        idempotencyKey: "reinit-w7c",
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

  const throwawayMembership = createOrganizationMembership({
    membershipId: "throwaway-w9",
    tenantScope: TENANT,
    principalRef: "throwaway-principal-w9",
    role: "STAFF",
  });
  assert.throws(
    () =>
      resolveControlledOrganizationSwitch({
        ledger: EMPTY_CONTROLLED_ORGANIZATION_PROVISIONING_LEDGER,
        organizationId: "org-never-provisioned-w9",
        currentMembership: throwawayMembership,
        currentPrincipalRef: "throwaway-principal-w9",
        authority: readAuthority(),
      }),
    (error: unknown) => error instanceof InvalidControlledOrganizationProvisioningTransitionError,
  );
});

test("W10 (cross-tenant rejection): suspending an organizationId under a DIFFERENT tenantScope than it was provisioned under fails closed", () => {
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

test("W12 (Rev203 F1 - baseline provisioning is complete): the snapshot composes a full OrganizationResourceBinding (project/context/resource binding, effective config/policy/quota/audit refs), not just Organization + founder identity", () => {
  const store = new FileDurableControlledOrganizationProvisioningStore(newStoreDir("w12"));
  const provisioned = store.provision({
    tenantScope: TENANT,
    organizationId: "org-w12",
    displayName: "Org W12",
    founderMembershipId: "founder-w12",
    founderPrincipalRef: "principal-w12",
    idempotencyKey: "provision-w12",
    occurredAt: "2026-10-08T00:00:00.000Z",
  });
  const { project, resourceBinding } = provisioned.snapshot;
  assert.equal(project.tenantId, TENANT.tenantId);
  assert.equal(project.customerId, "org-customer:org-w12");
  assert.equal(resourceBinding.organizationId, "org-w12");
  assert.equal(resourceBinding.projectRef, project.projectId);
  assert.ok(resourceBinding.membershipRefs.includes("founder-w12" as never));
  assert.deepEqual(resourceBinding.effectiveConfigRefs, []);
  assert.deepEqual(resourceBinding.effectivePolicyRefs, []);
  assert.deepEqual(resourceBinding.usageQuotaNamespaceRefs, []);
  assert.deepEqual(resourceBinding.auditRecoveryRefs, []);
});
