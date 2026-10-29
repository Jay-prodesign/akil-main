import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createOrganization, type Organization } from "../src/domain/organization.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext } from "../src/domain/authority.js";
import {
  createDelegatedAccessGrant,
  revokeDelegatedAccessGrant,
  isDelegatedAccessGrantActive,
  InvalidDelegatedAccessGrantTransitionError,
  type DelegatedAccessGrant,
} from "../src/domain/delegated-access-grant.js";
import {
  FileDurableDelegatedAccessGrantStore,
  CorruptedDelegatedAccessGrantLineError,
  DuplicateDelegatedAccessGrantError,
  DelegatedAccessGrantNotFoundError,
  InvalidDurableDelegatedAccessGrantStoreError,
} from "../src/domain/durable-delegated-access-grant-store.js";

/**
 * D12 (delegated-access half, unblocked once C7 landed):
 * `FileDurableDelegatedAccessGrantStore` - mirrors
 * `durable-break-glass-access-grant-store.test.ts`'s own witnesses (create
 * once, revise at most once ACTIVE -> REVOKED, latest wins, restart-safety,
 * corrupted-file, cross-tenant), adapted to `DelegatedAccessGrant`.
 */

const TENANT_A = createTenantScope("tenant-dag-store-a");
const TENANT_B = createTenantScope("tenant-dag-store-b");
const ORG_A: Organization = createOrganization({
  organizationId: "org-dag-a",
  tenantScope: TENANT_A,
  displayName: "Org A",
  createdAt: "2026-01-01T00:00:00.000Z",
});
const ORG_B: Organization = createOrganization({
  organizationId: "org-dag-b",
  tenantScope: TENANT_B,
  displayName: "Org B",
  createdAt: "2026-01-01T00:00:00.000Z",
});
const DELEGATOR_MEMBERSHIP_A = createOrganizationMembership({
  membershipId: "membership-dag-a",
  tenantScope: TENANT_A,
  principalRef: "staff-delegator-a",
  role: "STAFF",
});
const DELEGATOR_AUTHORITY_A = createAuthorityContext({
  tenantScope: TENANT_A,
  permissions: ["READ", "WRITE", "EXECUTE"],
  canPerformProtectedActions: true,
});

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "durable-delegated-access-grant-"));
}

function grantFile(dir: string, tenantId: string): string {
  return join(dir, `${Buffer.from(tenantId, "utf8").toString("base64url")}.delegation.jsonl`);
}

function grantFor(
  overrides: {
    delegationId?: string;
    organization?: Organization;
    permissions?: ReadonlyArray<string>;
    canPerformProtectedActions?: boolean;
    projectId?: string;
    expiresAt?: string;
  } = {},
): DelegatedAccessGrant {
  return createDelegatedAccessGrant({
    tenantScope: TENANT_A,
    organization: overrides.organization ?? ORG_A,
    delegatorMembership: DELEGATOR_MEMBERSHIP_A,
    delegatorAuthority: DELEGATOR_AUTHORITY_A,
    delegationId: overrides.delegationId ?? "dag-grant-1",
    delegatePrincipalRef: "staff-delegate-1",
    permissions: overrides.permissions ?? ["READ", "WRITE"],
    canPerformProtectedActions: overrides.canPerformProtectedActions ?? false,
    ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
    issuedAt: "2026-10-29T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-11-29T00:00:00.000Z",
  });
}

function revoke(grant: DelegatedAccessGrant, revokedAt = "2026-10-29T01:00:00.000Z"): DelegatedAccessGrant {
  return revokeDelegatedAccessGrant({ grant, revokedAt, revokedReason: "no longer needed" });
}

function withDir(run: (dir: string) => void): void {
  const dir = freshDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("D12 delegation store: putIfAbsentGrant/getGrant round-trip; an identical replay is an idempotent no-op", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    const grant = grantFor();
    const first = store.putIfAbsentGrant(grant);
    assert.equal(first.created, true);
    assert.deepEqual(first.value, grant);
    assert.deepEqual(store.getGrant(TENANT_A, "dag-grant-1"), grant);

    const replay = store.putIfAbsentGrant(grantFor());
    assert.equal(replay.created, false);
    assert.deepEqual(replay.value, grant);
    assert.equal(readFileSync(grantFile(dir, TENANT_A.tenantId), "utf8").trim().split("\n").length, 1);
    assert.equal(store.getGrant(TENANT_A, "no-such-grant"), undefined);
  });
});

test("D12 delegation store: a DIFFERENT grant under the same (tenantId, delegationId) is rejected with DuplicateDelegatedAccessGrantError, never overwritten", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor());
    assert.throws(() => store.putIfAbsentGrant(grantFor({ permissions: ["READ"] })), DuplicateDelegatedAccessGrantError);
    assert.throws(() => store.putIfAbsentGrant(grantFor({ expiresAt: "2099-01-01T00:00:00.000Z" })), DuplicateDelegatedAccessGrantError);
    assert.deepEqual([...(store.getGrant(TENANT_A, "dag-grant-1")?.permissions ?? [])].sort(), ["READ", "WRITE"]);
    assert.equal(store.getGrant(TENANT_A, "dag-grant-1")?.expiresAt, "2026-11-29T00:00:00.000Z");
  });
});

test("D12 delegation store: putIfAbsentGrant rejects a REVOKED grant and any hand-built invalid grant before anything is written", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    assert.throws(() => store.putIfAbsentGrant(revoke(grantFor())), InvalidDurableDelegatedAccessGrantStoreError);
    const invalid: ReadonlyArray<DelegatedAccessGrant> = [
      { ...grantFor(), permissions: new Set(["EVERYTHING" as never]) },
      { ...grantFor(), delegatePrincipalRef: "   " },
      { ...grantFor(), expiresAt: "not-a-date" },
      { ...grantFor(), delegationId: " dag-grant-1 " as never },
      { ...grantFor(), canPerformProtectedActions: "yes" as never },
      { ...grantFor(), state: "ACTIVE", revokedAt: "2026-10-29T01:00:00.000Z" },
      { ...grantFor(), extra: "field" } as DelegatedAccessGrant,
      { ...grantFor(), expiresAt: grantFor().issuedAt },
    ];
    for (const grant of invalid) {
      assert.throws(() => store.putIfAbsentGrant(grant), InvalidDurableDelegatedAccessGrantStoreError, JSON.stringify([...((grant as DelegatedAccessGrant).permissions ?? [])]));
    }
    assert.equal(existsSync(grantFile(dir, TENANT_A.tenantId)), false);
  });
});

test("D12 delegation store: an empty permissions set is a legitimate ACTIVE grant (protected-action-only delegation)", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    const grant = createDelegatedAccessGrant({
      tenantScope: TENANT_A,
      organization: ORG_A,
      delegatorMembership: DELEGATOR_MEMBERSHIP_A,
      delegatorAuthority: DELEGATOR_AUTHORITY_A,
      delegationId: "dag-grant-empty-permissions",
      delegatePrincipalRef: "staff-delegate-1",
      permissions: [],
      canPerformProtectedActions: false,
      issuedAt: "2026-10-29T00:00:00.000Z",
      expiresAt: "2026-11-29T00:00:00.000Z",
    });
    const result = store.putIfAbsentGrant(grant);
    assert.equal(result.created, true);
    assert.equal(result.value.permissions.size, 0);
  });
});

test("D12 delegation store: reviseGrant with revokeDelegatedAccessGrant records REVOKED once, and getGrant's latest-wins read returns the revision, not the original ACTIVE creation", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    const grant = grantFor();
    store.putIfAbsentGrant(grant);
    assert.equal(isDelegatedAccessGrantActive(store.getGrant(TENANT_A, "dag-grant-1")!, "2026-10-29T00:30:00.000Z"), true);

    const revised = store.reviseGrant({ tenantScope: TENANT_A, delegationId: "dag-grant-1", revise: (current) => revoke(current) });
    assert.equal(revised.created, true);
    assert.equal(revised.value.state, "REVOKED");
    const latest = store.getGrant(TENANT_A, "dag-grant-1");
    assert.equal(latest?.state, "REVOKED");
    assert.equal(latest?.revokedReason, "no longer needed");
    assert.equal(isDelegatedAccessGrantActive(latest!, "2026-10-29T00:30:00.000Z"), false);
    assert.deepEqual(latest, revoke(grant));
  });
});

test("D12 delegation store: reviseGrant on a grant that does not exist throws DelegatedAccessGrantNotFoundError and never calls revise", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    let called = false;
    assert.throws(
      () =>
        store.reviseGrant({
          tenantScope: TENANT_A,
          delegationId: "dag-grant-missing",
          revise: (current) => {
            called = true;
            return revoke(current);
          },
        }),
      DelegatedAccessGrantNotFoundError,
    );
    assert.equal(called, false);
    assert.equal(store.getGrant(TENANT_A, "dag-grant-missing"), undefined);
  });
});

test("D12 delegation store: REVOKED is terminal - revoking again throws (from the domain), a different revision is rejected, and the SAME revision is an idempotent no-op", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor());
    const revokedOnce = store.reviseGrant({ tenantScope: TENANT_A, delegationId: "dag-grant-1", revise: (current) => revoke(current) }).value;

    assert.throws(
      () => store.reviseGrant({ tenantScope: TENANT_A, delegationId: "dag-grant-1", revise: (current) => revoke(current) }),
      InvalidDelegatedAccessGrantTransitionError,
    );
    assert.throws(
      () =>
        store.reviseGrant({
          tenantScope: TENANT_A,
          delegationId: "dag-grant-1",
          revise: (current) => ({ ...current, revokedAt: "2026-10-29T02:00:00.000Z" }),
        }),
      InvalidDurableDelegatedAccessGrantStoreError,
    );
    const idempotent = store.reviseGrant({ tenantScope: TENANT_A, delegationId: "dag-grant-1", revise: (current) => current });
    assert.equal(idempotent.created, false);
    assert.deepEqual(store.getGrant(TENANT_A, "dag-grant-1"), revokedOnce);
    assert.equal(readFileSync(grantFile(dir, TENANT_A.tenantId), "utf8").trim().split("\n").length, 2);
  });
});

test("D12 delegation store: the only legitimate revision is ACTIVE -> REVOKED with every other field unchanged - extending expiry, widening permissions, re-targeting or staying ACTIVE is rejected", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor());
    const illegal: ReadonlyArray<(current: DelegatedAccessGrant) => DelegatedAccessGrant> = [
      (current) => ({ ...current, expiresAt: "2099-01-01T00:00:00.000Z" }),
      (current) => ({ ...current, permissions: new Set(["READ", "WRITE", "EXECUTE"]) }),
      (current) => ({ ...revoke(current), expiresAt: "2099-01-01T00:00:00.000Z" }),
      (current) => ({ ...revoke(current), delegatePrincipalRef: "staff-someone-else" }),
      (current) => ({ ...revoke(current), canPerformProtectedActions: true }),
    ];
    for (const revise of illegal) {
      assert.throws(() => store.reviseGrant({ tenantScope: TENANT_A, delegationId: "dag-grant-1", revise }), InvalidDurableDelegatedAccessGrantStoreError);
    }
    assert.throws(
      () => store.reviseGrant({ tenantScope: TENANT_A, delegationId: "dag-grant-1", revise: (current) => ({ ...revoke(current), tenantId: TENANT_B.tenantId }) }),
      InvalidDurableDelegatedAccessGrantStoreError,
    );
    assert.deepEqual(store.getGrant(TENANT_A, "dag-grant-1"), grantFor());
  });
});

test("D12 delegation store: restart-safety - a fresh store instance over the same baseDir reconstructs identical state, including a revision", () => {
  withDir((dir) => {
    const first = new FileDurableDelegatedAccessGrantStore(dir);
    first.putIfAbsentGrant(grantFor({ delegationId: "dag-grant-restart-1" }));
    first.putIfAbsentGrant(grantFor({ delegationId: "dag-grant-restart-2", permissions: ["EXECUTE"] }));
    first.reviseGrant({ tenantScope: TENANT_A, delegationId: "dag-grant-restart-2", revise: (current) => revoke(current) });

    const second = new FileDurableDelegatedAccessGrantStore(dir);
    assert.deepEqual(second.getGrant(TENANT_A, "dag-grant-restart-1"), first.getGrant(TENANT_A, "dag-grant-restart-1"));
    assert.deepEqual(second.getGrant(TENANT_A, "dag-grant-restart-2"), revoke(grantFor({ delegationId: "dag-grant-restart-2", permissions: ["EXECUTE"] })));
    assert.throws(() => second.putIfAbsentGrant(grantFor({ delegationId: "dag-grant-restart-1", permissions: ["EXECUTE"] })), DuplicateDelegatedAccessGrantError);
  });
});

test("D12 delegation store: cross-tenant isolation - the same delegationId under two tenants are independent grants, and a lookup under tenant B never sees tenant A's grant", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor({ delegationId: "dag-grant-shared", organization: ORG_A, permissions: ["READ"] }));
    assert.equal(store.getGrant(TENANT_B, "dag-grant-shared"), undefined);
    const membershipB = createOrganizationMembership({ membershipId: "membership-dag-b", tenantScope: TENANT_B, principalRef: "staff-delegator-b", role: "STAFF" });
    const authorityB = createAuthorityContext({ tenantScope: TENANT_B, permissions: ["EXECUTE"], canPerformProtectedActions: false });
    const grantB = createDelegatedAccessGrant({
      tenantScope: TENANT_B,
      organization: ORG_B,
      delegatorMembership: membershipB,
      delegatorAuthority: authorityB,
      delegationId: "dag-grant-shared",
      delegatePrincipalRef: "staff-delegate-1",
      permissions: ["EXECUTE"],
      canPerformProtectedActions: false,
      issuedAt: "2026-10-29T00:00:00.000Z",
      expiresAt: "2026-11-29T00:00:00.000Z",
    });
    store.putIfAbsentGrant(grantB);
    assert.deepEqual([...(store.getGrant(TENANT_A, "dag-grant-shared")?.permissions ?? [])], ["READ"]);
    assert.deepEqual([...(store.getGrant(TENANT_B, "dag-grant-shared")?.permissions ?? [])], ["EXECUTE"]);

    store.reviseGrant({ tenantScope: TENANT_A, delegationId: "dag-grant-shared", revise: (current) => revoke(current) });
    assert.equal(store.getGrant(TENANT_A, "dag-grant-shared")?.state, "REVOKED");
    assert.equal(store.getGrant(TENANT_B, "dag-grant-shared")?.state, "ACTIVE");
  });
});

function assertCorruptedLine(line: string, label: string): void {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    writeFileSync(grantFile(dir, TENANT_A.tenantId), `${line}\n`, "utf8");
    assert.throws(() => store.getGrant(TENANT_A, "dag-grant-1"), CorruptedDelegatedAccessGrantLineError, label);
  });
}

test("D12 delegation store adversarial (corrupted file): every malformed persisted line fails closed with CorruptedDelegatedAccessGrantLineError - never blind-cast", () => {
  const valid = grantFor();
  const validJson = { ...valid, permissions: [...valid.permissions] };
  const line = (grant: unknown, delegationId: unknown = "dag-grant-1"): string => JSON.stringify({ delegationId, grant });
  const cases: ReadonlyArray<{ label: string; line: string }> = [
    { label: "not valid JSON", line: "{not json" },
    { label: "a JSON array line", line: JSON.stringify([validJson]) },
    { label: "a primitive line", line: "42" },
    { label: "missing grant", line: JSON.stringify({ delegationId: "dag-grant-1" }) },
    { label: "empty line key", line: line(validJson, "") },
    { label: "line key does not match grant.delegationId", line: line(validJson, "dag-grant-other") },
    { label: "cross-tenant contamination (tenantId B in tenant A's file)", line: line({ ...validJson, tenantId: TENANT_B.tenantId }) },
    { label: "unrecognized permission literal", line: line({ ...validJson, permissions: ["READ", "EVERYTHING"] }) },
    { label: "permissions not an array", line: line({ ...validJson, permissions: "READ" }) },
    { label: "missing expiresAt", line: line({ ...validJson, expiresAt: undefined }) },
    { label: "invalid expiresAt", line: line({ ...validJson, expiresAt: "tomorrow-ish" }) },
    { label: "expiresAt not after issuedAt", line: line({ ...validJson, expiresAt: validJson.issuedAt }) },
    { label: "empty delegatePrincipalRef", line: line({ ...validJson, delegatePrincipalRef: "" }) },
    { label: "canPerformProtectedActions not boolean", line: line({ ...validJson, canPerformProtectedActions: "false" }) },
    { label: "unknown state", line: line({ ...validJson, state: "SUSPENDED" }) },
    { label: "ACTIVE carrying revocation metadata", line: line({ ...validJson, revokedAt: "2026-10-29T01:00:00.000Z", revokedReason: "x" }) },
    { label: "REVOKED missing revokedReason", line: line({ ...validJson, state: "REVOKED", revokedAt: "2026-10-29T01:00:00.000Z" }) },
    { label: "unknown extra field", line: line({ ...validJson, superuser: true }) },
    { label: "whitespace-padded delegatePrincipalRef", line: line({ ...validJson, delegatePrincipalRef: " staff-delegate-1 " }) },
    { label: "invalid tenantId", line: line({ ...validJson, tenantId: "" }) },
  ];
  for (const entry of cases) {
    assertCorruptedLine(entry.line, entry.label);
  }
});

test("D12 delegation store adversarial (corrupted file): one corrupted line poisons the whole tenant file (fail closed, never a silently-skipped line), while another tenant's file stays readable", () => {
  withDir((dir) => {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    store.putIfAbsentGrant(grantFor({ organization: ORG_A }));
    const membershipB = createOrganizationMembership({ membershipId: "membership-dag-b2", tenantScope: TENANT_B, principalRef: "staff-delegator-b2", role: "STAFF" });
    const authorityB = createAuthorityContext({ tenantScope: TENANT_B, permissions: ["READ"], canPerformProtectedActions: false });
    store.putIfAbsentGrant(
      createDelegatedAccessGrant({
        tenantScope: TENANT_B,
        organization: ORG_B,
        delegatorMembership: membershipB,
        delegatorAuthority: authorityB,
        delegationId: "dag-grant-1",
        delegatePrincipalRef: "staff-delegate-1",
        permissions: ["READ"],
        canPerformProtectedActions: false,
        issuedAt: "2026-10-29T00:00:00.000Z",
        expiresAt: "2026-11-29T00:00:00.000Z",
      }),
    );
    appendFileSync(grantFile(dir, TENANT_A.tenantId), "{broken\n", "utf8");
    assert.throws(() => store.getGrant(TENANT_A, "dag-grant-1"), CorruptedDelegatedAccessGrantLineError);
    assert.equal(store.getGrant(TENANT_B, "dag-grant-1")?.tenantId, TENANT_B.tenantId);
  });
});

test("stale lock reclaim: a lock file abandoned by a crashed process is reclaimed, so a later caller succeeds quickly rather than stalling for the full lock timeout", () => {
  const dir = freshDir();
  try {
    const store = new FileDurableDelegatedAccessGrantStore(dir);
    const safeKey = Buffer.from("tenant-dag-store-stale", "utf8").toString("base64url");
    const lockPath = join(dir, ".delegation-file-locks", `${safeKey}.lock`);
    mkdirSync(join(dir, ".delegation-file-locks"), { recursive: true });
    writeFileSync(lockPath, "99999999", "utf8");
    const past = new Date(Date.now() - 31_000);
    utimesSync(lockPath, past, past);
    const startedAt = Date.now();
    const result = store.getGrant(createTenantScope("tenant-dag-store-stale"), "dag-grant-does-not-exist");
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result, undefined);
    assert.ok(elapsedMs < 2000, `expected the stale lock to be reclaimed quickly, took ${elapsedMs}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
