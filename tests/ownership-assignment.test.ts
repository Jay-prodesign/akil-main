import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createOwnershipAssignment,
  reassignOwnership,
  resolveCurrentOwner,
  InvalidOwnershipAssignmentError,
} from "../src/domain/ownership-assignment.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createProjectOwnershipRef } from "../src/domain/project-ownership.js";

const tenantA = createTenantScope("tenant-a");
const tenantB = createTenantScope("tenant-b");

const ownershipA = createProjectOwnershipRef({
  tenantId: "tenant-a",
  customerId: "customer-1",
  projectId: "project-1",
});

const membershipA1 = createOrganizationMembership({
  membershipId: "membership-a-1",
  tenantScope: tenantA,
  principalRef: "principal-1",
  role: "STAFF",
});

const membershipA2 = createOrganizationMembership({
  membershipId: "membership-a-2",
  tenantScope: tenantA,
  principalRef: "principal-2",
  role: "STAFF",
});

const membershipB1 = createOrganizationMembership({
  membershipId: "membership-b-1",
  tenantScope: tenantB,
  principalRef: "principal-3",
  role: "STAFF",
});

test("a valid ownership assignment constructs deterministically", () => {
  const build = () =>
    createOwnershipAssignment({
      ownershipAssignmentId: "assignment-1",
      membership: membershipA1,
      ownership: ownershipA,
      ownerRole: "DEAL_OWNER",
      assignedAt: "2026-08-27T00:00:00Z",
    });
  assert.deepEqual(build(), build());
});

test("all four owner roles are independently representable, and one role never implies another", () => {
  const leadOwner = createOwnershipAssignment({
    ownershipAssignmentId: "a-lead",
    membership: membershipA1,
    ownership: ownershipA,
    ownerRole: "LEAD_OWNER",
    assignedAt: "2026-08-27T00:00:00Z",
  });
  const dealOwner = createOwnershipAssignment({
    ownershipAssignmentId: "a-deal",
    membership: membershipA1,
    ownership: ownershipA,
    ownerRole: "DEAL_OWNER",
    assignedAt: "2026-08-27T00:00:00Z",
  });
  // One membership holds two distinct owner roles simultaneously via two
  // distinct records - neither record's existence implies the other role.
  assert.notEqual(leadOwner.ownershipAssignmentId, dealOwner.ownershipAssignmentId);
  assert.equal(leadOwner.ownerRole, "LEAD_OWNER");
  assert.equal(dealOwner.ownerRole, "DEAL_OWNER");
});

test("an invalid ownerRole rejects", () => {
  assert.throws(
    () =>
      createOwnershipAssignment({
        ownershipAssignmentId: "a-1",
        membership: membershipA1,
        ownership: ownershipA,
        ownerRole: "SUPER_OWNER",
        assignedAt: "2026-08-27T00:00:00Z",
      }),
    InvalidOwnershipAssignmentError,
  );
});

test("invalid/foreign owner reference fails closed: a membership from a different tenant than the ownership scope rejects", () => {
  assert.throws(
    () =>
      createOwnershipAssignment({
        ownershipAssignmentId: "a-1",
        membership: membershipB1,
        ownership: ownershipA,
        ownerRole: "ACCOUNT_OWNER",
        assignedAt: "2026-08-27T00:00:00Z",
      }),
    InvalidOwnershipAssignmentError,
  );
});

test("reassignment preserves exact scope (ownership + ownerRole unchanged) and only the assignee changes", () => {
  const original = createOwnershipAssignment({
    ownershipAssignmentId: "a-1",
    membership: membershipA1,
    ownership: ownershipA,
    ownerRole: "DELIVERY_OWNER",
    assignedAt: "2026-08-27T00:00:00Z",
  });
  const { superseded, next } = reassignOwnership({
    priorAssignment: original,
    newOwnershipAssignmentId: "a-2",
    newMembership: membershipA2,
    reassignedAt: "2026-08-27T01:00:00Z",
  });
  assert.deepEqual(next.ownership, original.ownership);
  assert.equal(next.ownerRole, original.ownerRole);
  assert.equal(next.membershipId, membershipA2.membershipId);
  assert.notEqual(next.membershipId, original.membershipId);
  // provenance: the superseded record is not erased - it retains the
  // original assignee and now also records how/when it was superseded.
  assert.equal(superseded.membershipId, membershipA1.membershipId);
  assert.equal(superseded.supersededAt, "2026-08-27T01:00:00Z");
  assert.equal(superseded.supersededByAssignmentId, next.ownershipAssignmentId);
  assert.equal(original.supersededAt, undefined, "the original object passed in is never mutated in place");
});

test("reassignment cannot cross tenant/client boundary", () => {
  const original = createOwnershipAssignment({
    ownershipAssignmentId: "a-1",
    membership: membershipA1,
    ownership: ownershipA,
    ownerRole: "LEAD_OWNER",
    assignedAt: "2026-08-27T00:00:00Z",
  });
  assert.throws(
    () =>
      reassignOwnership({
        priorAssignment: original,
        newOwnershipAssignmentId: "a-2",
        newMembership: membershipB1,
        reassignedAt: "2026-08-27T01:00:00Z",
      }),
    InvalidOwnershipAssignmentError,
  );
});

test("an already-superseded assignment cannot be reassigned again (stale-assignment protection)", () => {
  const original = createOwnershipAssignment({
    ownershipAssignmentId: "a-1",
    membership: membershipA1,
    ownership: ownershipA,
    ownerRole: "ACCOUNT_OWNER",
    assignedAt: "2026-08-27T00:00:00Z",
  });
  const { superseded } = reassignOwnership({
    priorAssignment: original,
    newOwnershipAssignmentId: "a-2",
    newMembership: membershipA2,
    reassignedAt: "2026-08-27T01:00:00Z",
  });
  assert.throws(
    () =>
      reassignOwnership({
        priorAssignment: superseded,
        newOwnershipAssignmentId: "a-3",
        newMembership: membershipA1,
        reassignedAt: "2026-08-27T02:00:00Z",
      }),
    InvalidOwnershipAssignmentError,
  );
});

test("resolveCurrentOwner: canonical current owner is found from history; a superseded (stale) record is never returned as current", () => {
  const original = createOwnershipAssignment({
    ownershipAssignmentId: "a-1",
    membership: membershipA1,
    ownership: ownershipA,
    ownerRole: "DEAL_OWNER",
    assignedAt: "2026-08-27T00:00:00Z",
  });
  const { superseded, next } = reassignOwnership({
    priorAssignment: original,
    newOwnershipAssignmentId: "a-2",
    newMembership: membershipA2,
    reassignedAt: "2026-08-27T01:00:00Z",
  });
  const current = resolveCurrentOwner({
    history: [superseded, next],
    ownership: ownershipA,
    ownerRole: "DEAL_OWNER",
  });
  assert.equal(current?.ownershipAssignmentId, next.ownershipAssignmentId);
  assert.notEqual(current?.ownershipAssignmentId, superseded.ownershipAssignmentId);
});

test("resolveCurrentOwner: no active record for the given scope/role returns undefined - a canonical 'no current owner' state, never guessed", () => {
  const current = resolveCurrentOwner({
    history: [],
    ownership: ownershipA,
    ownerRole: "LEAD_OWNER",
  });
  assert.equal(current, undefined);
});

test("resolveCurrentOwner: a data-integrity violation (two active records for the same exact scope/role) fails closed rather than guessing", () => {
  const first = createOwnershipAssignment({
    ownershipAssignmentId: "a-1",
    membership: membershipA1,
    ownership: ownershipA,
    ownerRole: "ACCOUNT_OWNER",
    assignedAt: "2026-08-27T00:00:00Z",
  });
  const second = createOwnershipAssignment({
    ownershipAssignmentId: "a-2",
    membership: membershipA2,
    ownership: ownershipA,
    ownerRole: "ACCOUNT_OWNER",
    assignedAt: "2026-08-27T00:00:01Z",
  });
  assert.throws(
    () =>
      resolveCurrentOwner({
        history: [first, second],
        ownership: ownershipA,
        ownerRole: "ACCOUNT_OWNER",
      }),
    InvalidOwnershipAssignmentError,
  );
});
