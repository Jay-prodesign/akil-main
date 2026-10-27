import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  createBreakGlassAccessGrant,
  revokeBreakGlassAccessGrant,
  type BreakGlassAccessGrant,
  type BreakGlassSupportAccessAudit,
} from "../src/domain/break-glass-support-access.js";
import {
  FileDurableBreakGlassSupportAccessAuditStore,
  DuplicateBreakGlassSupportAccessAuditError,
} from "../src/domain/durable-break-glass-support-access-audit-store.js";
import { createAuthenticatedStaffPrincipal, type StaffSessionContext } from "../src/web/staff-session-context.js";
import { createDevFixtureStaffSessionProvider } from "../src/web/dev-fixture-staff-session-provider.js";
import { StaffUnauthenticatedError } from "../src/web/staff-route-guard.js";
import {
  authorizeBreakGlassSupportAccessAsAuthenticatedStaff,
  type BreakGlassSupportAccessAuditSink,
} from "../src/web/authenticated-break-glass-support-access.js";

/**
 * C7 (gap scan 2026-10-23): the pure `authorizeBreakGlassSupportAccess`
 * treats `currentPrincipalRef` as caller-supplied evidence, exactly like
 * every other domain resolver here - it never authenticates it.
 * `authorizeBreakGlassSupportAccessAsAuthenticatedStaff` is the
 * authenticated ingress boundary OS-V1-09.md's own design decisions call
 * for: identity comes ONLY from a real resolved staff session, and every
 * GRANTED decision's audit is durably appended before it is returned.
 * Mirrors `authenticated-delegated-access.test.ts`'s fixture style.
 */

const SUPPORT_TENANT = createTenantScope("tenant-abg-support");
const TARGET_TENANT = createTenantScope("tenant-abg-target");
const NOW = "2026-10-27T00:30:00.000Z";

function grantFor(grantedToRef: string, overrides: { scope?: ReadonlyArray<unknown>; consentRequired?: boolean } = {}): BreakGlassAccessGrant {
  return createBreakGlassAccessGrant({
    grantId: `bg-grant-${grantedToRef}`,
    supportTenantScope: SUPPORT_TENANT,
    targetTenantScope: TARGET_TENANT,
    grantedToRef,
    grantedByRef: "staff-abg-approver",
    reason: "investigating a customer-reported incident",
    scope: overrides.scope ?? ["TASK", "QUOTA"],
    consentRequired: overrides.consentRequired ?? false,
    expiresAt: "2026-10-27T01:00:00.000Z",
  });
}

function sessionProvider(principalId: string, sessionToken: string, extra: Partial<StaffSessionContext> = {}) {
  const principal = createAuthenticatedStaffPrincipal({ principalId, displayName: `Staff ${principalId}` });
  return createDevFixtureStaffSessionProvider({
    fixtures: new Map([[sessionToken, { principal, issuedAt: "2026-10-27T00:00:00.000Z", ...extra }]]),
    isProduction: false,
  });
}

function withAuditStore(run: (store: FileDurableBreakGlassSupportAccessAuditStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "authenticated-break-glass-"));
  try {
    run(new FileDurableBreakGlassSupportAccessAuditStore(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A spy sink that records every append - used where the real store adds nothing to the witness. */
function spySink(): BreakGlassSupportAccessAuditSink & { readonly appended: BreakGlassSupportAccessAudit[] } {
  const appended: BreakGlassSupportAccessAudit[] = [];
  return { appended, append: (audit) => void appended.push(audit) };
}

test("C7 authenticated break-glass: a session authenticated as grant.grantedToRef is GRANTED, decidedByPrincipalRef is the session's own principal, and the audit is durably persisted to the real store", () => {
  withAuditStore((auditStore) => {
    const grant = grantFor("staff-abg-support-1");
    const decision = authorizeBreakGlassSupportAccessAsAuthenticatedStaff({
      grant,
      targetTenantScope: TARGET_TENANT,
      provider: sessionProvider("staff-abg-support-1", "token-abg-1"),
      sessionToken: "token-abg-1",
      requestedView: "TASK",
      auditRef: "audit-abg-1",
      now: NOW,
      auditStore,
    });
    assert.equal(decision.outcome, "GRANTED");
    const expected: BreakGlassSupportAccessAudit = {
      auditRef: "audit-abg-1",
      grantId: grant.grantId,
      supportTenantId: SUPPORT_TENANT.tenantId,
      targetTenantId: TARGET_TENANT.tenantId,
      requestedView: "TASK",
      decidedByPrincipalRef: "staff-abg-support-1",
      decidedAt: NOW,
    };
    assert.deepEqual(decision.outcome === "GRANTED" ? decision.audit : undefined, expected);
    assert.deepEqual(auditStore.findByTargetTenant(TARGET_TENANT), [expected]);
  });
});

test("C7 authenticated break-glass adversarial (forged/absent session): a forged or undefined sessionToken throws StaffUnauthenticatedError before the grant is ever consulted, and nothing is audited", () => {
  let grantTouched = false;
  const realGrant = grantFor("staff-abg-support-2");
  const watchedGrant = new Proxy(realGrant, {
    get(target, property, receiver) {
      grantTouched = true;
      return Reflect.get(target, property, receiver);
    },
  });
  const sink = spySink();
  for (const sessionToken of ["a-forged-unrelated-token", undefined]) {
    assert.throws(
      () =>
        authorizeBreakGlassSupportAccessAsAuthenticatedStaff({
          grant: watchedGrant,
          targetTenantScope: TARGET_TENANT,
          provider: sessionProvider("staff-abg-support-2", "token-abg-2"),
          sessionToken,
          requestedView: "TASK",
          auditRef: "audit-abg-2",
          now: NOW,
          auditStore: sink,
        }),
      StaffUnauthenticatedError,
    );
  }
  assert.equal(grantTouched, false, "the grant must never be read for an unauthenticated caller");
  assert.deepEqual(sink.appended, []);
});

test("C7 authenticated break-glass adversarial (expired / revoked staff session): a session past its own expiresAt, or REVOKED, is unauthenticated - never a DENIED that could be mistaken for a grant problem", () => {
  const grant = grantFor("staff-abg-support-3");
  const sink = spySink();
  const cases: ReadonlyArray<Partial<StaffSessionContext>> = [
    { expiresAt: "2026-10-27T00:10:00.000Z" },
    { state: "REVOKED", revokedAt: "2026-10-27T00:05:00.000Z", revokedReason: "offboarded" },
  ];
  for (const extra of cases) {
    assert.throws(
      () =>
        authorizeBreakGlassSupportAccessAsAuthenticatedStaff({
          grant,
          targetTenantScope: TARGET_TENANT,
          provider: sessionProvider("staff-abg-support-3", "token-abg-3", extra),
          sessionToken: "token-abg-3",
          requestedView: "TASK",
          auditRef: "audit-abg-3",
          now: NOW,
          auditStore: sink,
        }),
      StaffUnauthenticatedError,
      JSON.stringify(extra),
    );
  }
  assert.deepEqual(sink.appended, []);
});

test("C7 authenticated break-glass adversarial (stolen grant, IDENTITY1 through the wrapper): a session authenticated as a DIFFERENT principal than grant.grantedToRef is DENIED, and nothing is audited", () => {
  withAuditStore((auditStore) => {
    // Authenticated as an impostor holding someone else's valid grant. There
    // is no `currentPrincipalRef` field in this wrapper's input to assert
    // "I am the grantee" with - identity comes only from the session.
    const decision = authorizeBreakGlassSupportAccessAsAuthenticatedStaff({
      grant: grantFor("staff-abg-support-4"),
      targetTenantScope: TARGET_TENANT,
      provider: sessionProvider("staff-abg-impostor-4", "token-abg-4-impostor"),
      sessionToken: "token-abg-4-impostor",
      requestedView: "TASK",
      auditRef: "audit-abg-4",
      now: NOW,
      auditStore,
    });
    assert.equal(decision.outcome, "DENIED");
    assert.match(decision.outcome === "DENIED" ? decision.reason : "", /currentPrincipalRef does not match/);
    assert.deepEqual(auditStore.findByTargetTenant(TARGET_TENANT), []);
  });
});

test("C7 authenticated break-glass: every other DENIED path (out of scope, missing consent, revoked/expired grant, foreign tenant) appends nothing; supplying consent then succeeds", () => {
  const sink = spySink();
  const provider = sessionProvider("staff-abg-support-5", "token-abg-5");
  const base = {
    targetTenantScope: TARGET_TENANT,
    provider,
    sessionToken: "token-abg-5",
    auditRef: "audit-abg-5",
    now: NOW,
    auditStore: sink,
  };
  const grant = grantFor("staff-abg-support-5", { consentRequired: true });
  const denied = [
    authorizeBreakGlassSupportAccessAsAuthenticatedStaff({ ...base, grant, requestedView: "CONNECTION", consentRef: "consent-1" }),
    authorizeBreakGlassSupportAccessAsAuthenticatedStaff({ ...base, grant, requestedView: "TASK" }),
    authorizeBreakGlassSupportAccessAsAuthenticatedStaff({ ...base, grant, requestedView: "TASK", consentRef: "   " }),
    authorizeBreakGlassSupportAccessAsAuthenticatedStaff({
      ...base,
      grant: revokeBreakGlassAccessGrant({ grant, revokedAt: "2026-10-27T00:20:00.000Z", revokedReason: "closed" }),
      requestedView: "TASK",
      consentRef: "consent-1",
    }),
    authorizeBreakGlassSupportAccessAsAuthenticatedStaff({ ...base, grant, requestedView: "TASK", consentRef: "consent-1", now: "2026-10-27T01:00:00.000Z" }),
    authorizeBreakGlassSupportAccessAsAuthenticatedStaff({
      ...base,
      grant,
      targetTenantScope: createTenantScope("tenant-abg-someone-else"),
      requestedView: "TASK",
      consentRef: "consent-1",
    }),
  ];
  assert.deepEqual(denied.map((decision) => decision.outcome), ["DENIED", "DENIED", "DENIED", "DENIED", "DENIED", "DENIED"]);
  assert.equal(sink.appended.length, 0);

  const granted = authorizeBreakGlassSupportAccessAsAuthenticatedStaff({ ...base, grant, requestedView: "QUOTA", consentRef: "consent-1" });
  assert.equal(granted.outcome, "GRANTED");
  assert.equal(sink.appended.length, 1);
  assert.equal(sink.appended[0]?.requestedView, "QUOTA");
});

test("C7 authenticated break-glass adversarial (audit-before-return): a duplicate auditRef collision propagates DuplicateBreakGlassSupportAccessAuditError - it is NEVER converted into a GRANTED result whose evidence was not recorded", () => {
  withAuditStore((auditStore) => {
    const input = {
      grant: grantFor("staff-abg-support-6"),
      targetTenantScope: TARGET_TENANT,
      provider: sessionProvider("staff-abg-support-6", "token-abg-6"),
      sessionToken: "token-abg-6",
      auditRef: "audit-abg-6-colliding",
      now: NOW,
      auditStore,
    };
    assert.equal(authorizeBreakGlassSupportAccessAsAuthenticatedStaff({ ...input, requestedView: "TASK" }).outcome, "GRANTED");
    let result: unknown = "not-returned";
    assert.throws(() => {
      result = authorizeBreakGlassSupportAccessAsAuthenticatedStaff({ ...input, requestedView: "QUOTA" });
    }, DuplicateBreakGlassSupportAccessAuditError);
    assert.equal(result, "not-returned", "no decision may be returned when the audit append failed");
    const audits = auditStore.findByTargetTenant(TARGET_TENANT);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.requestedView, "TASK");
  });
});

test("C7 authenticated break-glass adversarial (audit-before-return): any audit sink failure propagates unchanged - never swallowed", () => {
  const failure = new Error("disk full");
  assert.throws(
    () =>
      authorizeBreakGlassSupportAccessAsAuthenticatedStaff({
        grant: grantFor("staff-abg-support-7"),
        targetTenantScope: TARGET_TENANT,
        provider: sessionProvider("staff-abg-support-7", "token-abg-7"),
        sessionToken: "token-abg-7",
        requestedView: "TASK",
        auditRef: "audit-abg-7",
        now: NOW,
        auditStore: {
          append: () => {
            throw failure;
          },
        },
      }),
    (error: unknown) => error === failure,
  );
});
