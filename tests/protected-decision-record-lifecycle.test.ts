import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import {
  createProtectedDecisionRecord,
  reviseProtectedDecisionRecord,
  ProtectedDecisionRecordTransitionError,
  InvalidProtectedDecisionRecordError,
} from "../src/domain/protected-decision-record.js";
import {
  FileDurableProtectedDecisionRecordStore,
  InvalidDurableProtectedDecisionRecordStoreError,
} from "../src/domain/durable-protected-decision-record-store.js";
import { createAuthenticatedStaffPrincipal } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import type { StaffAccessGrant } from "../src/web/internal-os-access.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import {
  createProtectedDecisionRecordAsAuthenticatedStaff,
  reviseProtectedDecisionRecordAsAuthenticatedStaff,
} from "../src/web/protected-decision-record-admin-access.js";

/**
 * Rev188 F3-item4: `durable-protected-decision-record-store.ts` is reworked
 * from an immutable-putIfAbsent record into a monotonic lifecycle -
 * `APPROVED -> REVOKED` is the only legitimate revision; `DENIED` and an
 * already-`REVOKED` record are both terminal. `getDecisionRecord` is a
 * "latest wins" read, so a later-appended REVOKED revision is always
 * observed over the original APPROVED creation - exactly the currentness
 * gap Brain's own residual named: "durable decision authority/lifecycle
 * not current."
 */

const tenantScope = createTenantScope("tenant-decision-lifecycle");

function authority() {
  // READ is required by requireInternalOsAccess's own Phase A gate (web
  // tests only); EXECUTE is required by the domain functions' own
  // protected-action checks.
  return createAuthorityContext({ tenantScope, permissions: ["READ", "EXECUTE"], canPerformProtectedActions: true });
}

function authoringFixture(principalRef = "principal-decision-lifecycle") {
  const organization: Organization = activateOrganization({
    organization: createOrganization({
      organizationId: "org-akilta-decision-lifecycle",
      tenantScope,
      displayName: "AKILTA (Organization Zero)",
      createdAt: "2026-10-02T00:00:00.000Z",
    }),
    activatedAt: "2026-10-02T00:00:01.000Z",
  });
  const membership: OrganizationMembership = createOrganizationMembership({
    membershipId: `membership-decision-lifecycle-${principalRef}`,
    tenantScope,
    principalRef,
    role: "STAFF",
  });
  return { organization, membership, currentPrincipalRef: principalRef, authority: authority() };
}

test("Rev188 item4: an APPROVED record can be revised exactly once to REVOKED, and getDecisionRecord's 'latest wins' read then returns the REVOKED revision, not the original APPROVED creation", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-decision-lifecycle-"));
  const store = new FileDurableProtectedDecisionRecordStore(baseDir);
  const approved = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-1",
    outcome: "APPROVED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:approved",
  });
  store.putIfAbsentDecisionRecord(tenantScope.tenantId, approved.decisionRef, approved);
  assert.equal(store.getDecisionRecord(tenantScope.tenantId, approved.decisionRef)!.outcome, "APPROVED");

  const revoked = reviseProtectedDecisionRecord({
    current: store.getDecisionRecord(tenantScope.tenantId, approved.decisionRef)!,
    tenantScope,
    outcome: "REVOKED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:05:00.000Z",
    evidenceRef: "evidence:revoked",
  });
  const result = store.reviseDecisionRecord(tenantScope.tenantId, approved.decisionRef, revoked);
  assert.equal(result.created, true);
  assert.equal(result.value.outcome, "REVOKED");

  const latest = store.getDecisionRecord(tenantScope.tenantId, approved.decisionRef);
  assert.equal(latest!.outcome, "REVOKED");
  assert.equal(latest!.evidenceRef, "evidence:revoked");
});

test("Rev188 item4 adversarial: a repeat of the SAME already-applied revision is a safe idempotent no-op, never a second durable REVOKED entry", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-decision-lifecycle-idempotent-"));
  const store = new FileDurableProtectedDecisionRecordStore(baseDir);
  const approved = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-idempotent",
    outcome: "APPROVED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:approved",
  });
  store.putIfAbsentDecisionRecord(tenantScope.tenantId, approved.decisionRef, approved);
  const revoked = reviseProtectedDecisionRecord({
    current: approved,
    tenantScope,
    outcome: "REVOKED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:05:00.000Z",
    evidenceRef: "evidence:revoked",
  });
  const first = store.reviseDecisionRecord(tenantScope.tenantId, approved.decisionRef, revoked);
  assert.equal(first.created, true);

  const second = store.reviseDecisionRecord(tenantScope.tenantId, approved.decisionRef, revoked);
  assert.equal(second.created, false);
  assert.deepEqual(second.value, first.value);
});

test("Rev188 item4 adversarial: an already-REVOKED record cannot be revised again with DIFFERENT content - rejected as a terminal-outcome conflict", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-decision-lifecycle-double-revoke-"));
  const store = new FileDurableProtectedDecisionRecordStore(baseDir);
  const approved = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-double-revoke",
    outcome: "APPROVED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:approved",
  });
  store.putIfAbsentDecisionRecord(tenantScope.tenantId, approved.decisionRef, approved);
  const firstRevocation = reviseProtectedDecisionRecord({
    current: approved,
    tenantScope,
    outcome: "REVOKED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:05:00.000Z",
    evidenceRef: "evidence:revoked-first",
  });
  store.reviseDecisionRecord(tenantScope.tenantId, approved.decisionRef, firstRevocation);

  const latestNow = store.getDecisionRecord(tenantScope.tenantId, approved.decisionRef)!;
  assert.throws(
    () =>
      reviseProtectedDecisionRecord({
        current: latestNow,
        tenantScope,
        outcome: "REVOKED",
        ...authoringFixture(),
        decidedAt: "2026-10-02T00:06:00.000Z",
        evidenceRef: "evidence:revoked-second",
      }),
    ProtectedDecisionRecordTransitionError,
  );
});

test("Rev188 item4 adversarial: a DENIED record can never be revised - rejected before any authenticated-access check even runs", () => {
  const denied = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-denied",
    outcome: "DENIED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:denied",
  });
  assert.throws(
    () =>
      reviseProtectedDecisionRecord({
        current: denied,
        tenantScope,
        outcome: "REVOKED",
        ...authoringFixture(),
        decidedAt: "2026-10-02T00:05:00.000Z",
        evidenceRef: "evidence:attempted-revoke",
      }),
    ProtectedDecisionRecordTransitionError,
  );
});

test("Rev188 item4 adversarial: an APPROVED record cannot be 'revised' to any outcome other than REVOKED", () => {
  const approved = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-wrong-target",
    outcome: "APPROVED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:approved",
  });
  assert.throws(
    () =>
      reviseProtectedDecisionRecord({
        current: approved,
        tenantScope,
        outcome: "DENIED",
        ...authoringFixture(),
        decidedAt: "2026-10-02T00:05:00.000Z",
        evidenceRef: "evidence:attempted-deny",
      }),
    ProtectedDecisionRecordTransitionError,
  );
});

test("Rev188 item4 adversarial: the durable store defensively rejects a revision whose outcome is not REVOKED, even if a caller bypassed reviseProtectedDecisionRecord's own domain-level check", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-decision-lifecycle-store-defense-"));
  const store = new FileDurableProtectedDecisionRecordStore(baseDir);
  const approved = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-store-defense",
    outcome: "APPROVED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:approved",
  });
  store.putIfAbsentDecisionRecord(tenantScope.tenantId, approved.decisionRef, approved);
  const forgedRevision = { ...approved, outcome: "DENIED" as const, evidenceRef: "evidence:forged" };
  assert.throws(
    () => store.reviseDecisionRecord(tenantScope.tenantId, approved.decisionRef, forgedRevision),
    InvalidDurableProtectedDecisionRecordStoreError,
  );
});

test("Rev188 item4 adversarial: reviseDecisionRecord on a decisionRef with no existing durable record fails closed", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "os-v0-10-decision-lifecycle-no-record-"));
  const store = new FileDurableProtectedDecisionRecordStore(baseDir);
  const phantom = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-never-created",
    outcome: "REVOKED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:05:00.000Z",
    evidenceRef: "evidence:phantom",
  });
  assert.throws(
    () => store.reviseDecisionRecord(tenantScope.tenantId, phantom.decisionRef, phantom),
    InvalidDurableProtectedDecisionRecordStoreError,
  );
});

test("Rev188 item4 adversarial: reviseProtectedDecisionRecord's own authenticated-access check still fails closed for a forged currentPrincipalRef/membership mismatch, exactly like createProtectedDecisionRecord's", () => {
  const approved = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-forged-access",
    outcome: "APPROVED",
    ...authoringFixture(),
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:approved",
  });
  const fixture = authoringFixture();
  assert.throws(
    () =>
      reviseProtectedDecisionRecord({
        current: approved,
        tenantScope,
        outcome: "REVOKED",
        ...fixture,
        currentPrincipalRef: "a-forged-unrelated-principal",
        decidedAt: "2026-10-02T00:05:00.000Z",
        evidenceRef: "evidence:revoked",
      }),
    InvalidProtectedDecisionRecordError,
  );
});

function staffFixture(principalRef = "principal-decision-lifecycle-web") {
  const fixture = authoringFixture(principalRef);
  const principal = createAuthenticatedStaffPrincipal({ principalId: principalRef, displayName: "Decision Lifecycle Staff" });
  const sessionToken = `token-${principalRef}`;
  const provider = createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-02T00:00:00.000Z" }]]),
    isProduction: false,
  });
  const grant: StaffAccessGrant = { membership: fixture.membership, authority: fixture.authority, assignments: [] };
  return { organization: fixture.organization, provider, sessionToken, grants: [grant], authority: fixture.authority };
}

test("Rev188 item4 (web layer): a valid authenticated staff session creates and then revises a decision record end to end", () => {
  const staff = staffFixture();
  const created = createProtectedDecisionRecordAsAuthenticatedStaff({
    tenantScope,
    decisionRef: "decision:lifecycle-web-golden",
    outcome: "APPROVED",
    ...staff,
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:approved-web",
  });
  assert.equal(created.outcome, "APPROVED");

  const revised = reviseProtectedDecisionRecordAsAuthenticatedStaff({
    current: created,
    tenantScope,
    outcome: "REVOKED",
    ...staff,
    decidedAt: "2026-10-02T00:05:00.000Z",
    evidenceRef: "evidence:revoked-web",
  });
  assert.equal(revised.outcome, "REVOKED");
});

test("Rev188 item4 (web layer) adversarial: a forged sessionToken fails inside requireInternalOsAccess itself, before either domain function is ever reached", () => {
  const staff = staffFixture();
  assert.throws(
    () =>
      createProtectedDecisionRecordAsAuthenticatedStaff({
        tenantScope,
        decisionRef: "decision:lifecycle-web-forged",
        outcome: "APPROVED",
        ...staff,
        sessionToken: "a-forged-unrelated-session-token",
        decidedAt: "2026-10-02T00:00:30.000Z",
        evidenceRef: "evidence:approved-web",
      }),
    StaffUnauthenticatedError,
  );
});

test("Rev189 R4: decidedByPrincipalRef stores the actual authenticated principalRef, never the structurally-different OrganizationMembership membershipId", () => {
  const principalRef = "principal-decision-lifecycle-r4";
  const fixture = authoringFixture(principalRef);
  assert.notEqual(fixture.membership.membershipId, principalRef, "the fixture's membershipId must be a different string than principalRef for this to be a genuine proof");

  const approved = createProtectedDecisionRecord({
    tenantScope,
    decisionRef: "decision:lifecycle-r4",
    outcome: "APPROVED",
    ...fixture,
    decidedAt: "2026-10-02T00:00:30.000Z",
    evidenceRef: "evidence:approved-r4",
  });
  assert.equal(approved.decidedByPrincipalRef, principalRef);
  assert.notEqual(approved.decidedByPrincipalRef, fixture.membership.membershipId);

  const revoked = reviseProtectedDecisionRecord({
    current: approved,
    tenantScope,
    outcome: "REVOKED",
    ...fixture,
    decidedAt: "2026-10-02T00:05:00.000Z",
    evidenceRef: "evidence:revoked-r4",
  });
  assert.equal(revoked.decidedByPrincipalRef, principalRef);
  assert.notEqual(revoked.decidedByPrincipalRef, fixture.membership.membershipId);
});
