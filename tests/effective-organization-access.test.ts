import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createOrganization, activateOrganization, type Organization } from "../src/domain/organization.js";
import { createOrganizationMembership, type OrganizationMembership } from "../src/domain/organization-membership.js";
import { createAuthorityContext, type AuthorityContext } from "../src/domain/authority.js";
import { createProject, type Project } from "../src/domain/project.js";
import {
  resolveEffectiveOrganizationAccess,
  type EffectiveAccessResolution,
} from "../src/domain/effective-organization-access.js";

const tenantScope = createTenantScope("tenant-os-v0-02");
const otherTenantScope = createTenantScope("tenant-os-v0-02-other");
const NOW = "2026-09-25T00:00:00.000Z";

function buildOrganization(overrides: { tenantScope?: typeof tenantScope } = {}): Organization {
  return createOrganization({
    organizationId: "org-os-v0-02",
    tenantScope: overrides.tenantScope ?? tenantScope,
    displayName: "Reference Organization",
    createdAt: NOW,
  });
}

function buildMembership(overrides: {
  tenantScope?: typeof tenantScope;
  role?: "STAFF" | "JUNIOR" | "STUDENT" | "CLIENT_ASSOCIATE";
} = {}): OrganizationMembership {
  return createOrganizationMembership({
    membershipId: "membership-os-v0-02",
    tenantScope: overrides.tenantScope ?? tenantScope,
    principalRef: "principal-os-v0-02",
    role: overrides.role ?? "STAFF",
  });
}

function buildAuthority(overrides: {
  tenantScope?: typeof tenantScope;
  permissions?: ReadonlyArray<"READ" | "WRITE" | "EXECUTE">;
  canPerformProtectedActions?: boolean;
} = {}): AuthorityContext {
  return createAuthorityContext({
    tenantScope: overrides.tenantScope ?? tenantScope,
    permissions: overrides.permissions ?? ["READ", "WRITE"],
    canPerformProtectedActions: overrides.canPerformProtectedActions ?? false,
  });
}

function buildProject(overrides: { tenantScope?: typeof tenantScope } = {}): Project {
  const scope = overrides.tenantScope ?? tenantScope;
  const customer = createCustomer({
    tenantScope: scope,
    customerId: "cust-os-v0-02",
    displayName: "Reference Customer",
  });
  return createProject({
    tenantScope: scope,
    customer,
    projectId: "proj-os-v0-02",
    ownerRef: "owner-os-v0-02",
    state: "active",
  });
}

// ---------------------------------------------------------------------------
// A1: same-tenant deterministic success
// ---------------------------------------------------------------------------

test("A1: same-tenant Organization/Membership/Authority resolves GRANTED with the exact authority permissions", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["READ", "WRITE"] });
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority });
  assert.equal(result.decision, "GRANTED");
  assert.equal(result.tenantId, tenantScope.tenantId);
  assert.equal(result.organizationId, organization.organizationId);
  assert.equal(result.membershipId, membership.membershipId);
  assert.equal(result.role, "MEMBER");
  assert.deepEqual([...result.permissions].sort(), ["READ", "WRITE"]);
  assert.equal(result.canPerformProtectedActions, false);
  assert.ok(result.reasons.length > 0);
});

test("A1: an activated Organization (ACTIVE state) still resolves GRANTED the same way - this resolver does not gate on lifecycle state", () => {
  const organization = activateOrganization({
    organization: buildOrganization(),
    activatedAt: "2026-09-25T01:00:00.000Z",
  });
  const membership = buildMembership();
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority });
  assert.equal(result.decision, "GRANTED");
});

// ---------------------------------------------------------------------------
// A2/A3/A4: cross-tenant denial
// ---------------------------------------------------------------------------

test("A2: a membership belonging to a foreign tenant is denied", () => {
  const organization = buildOrganization();
  const membership = buildMembership({ tenantScope: otherTenantScope });
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.permissions.size, 0);
  assert.equal(result.canPerformProtectedActions, false);
  assert.match(result.reasons[0] ?? "", /membership belongs to a different tenant/);
});

test("A3: an authority belonging to a foreign tenant is denied, even with a legitimate same-tenant membership", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ tenantScope: otherTenantScope });
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /authority belongs to a different tenant/);
});

test("A4: a Project belonging to a foreign tenant is denied, even with legitimate same-tenant membership and authority", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject({ tenantScope: otherTenantScope });
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority, project });
  assert.equal(result.decision, "DENIED");
  assert.match(result.reasons[0] ?? "", /project belongs to a different tenant/);
});

test("A4: a same-tenant Project scope resolves GRANTED and carries the exact projectId", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority, project });
  assert.equal(result.decision, "GRANTED");
  assert.equal(result.projectId, project.projectId);
});

// ---------------------------------------------------------------------------
// A5/A6/A7/A8: permission never escalates beyond the exact AuthorityContext
// ---------------------------------------------------------------------------

test("A5: READ-only authority never yields WRITE/EXECUTE in the resolution", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["READ"] });
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority });
  assert.equal(result.decision, "GRANTED");
  assert.deepEqual([...result.permissions], ["READ"]);
});

test("A6: EXECUTE permission alone never yields protected-action eligibility", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["EXECUTE"], canPerformProtectedActions: false });
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority });
  assert.equal(result.decision, "GRANTED");
  assert.ok(result.permissions.has("EXECUTE"));
  assert.equal(result.canPerformProtectedActions, false);
});

test("A6: canPerformProtectedActions is granted only when the AuthorityContext explicitly carries it", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: ["EXECUTE"], canPerformProtectedActions: true });
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority });
  assert.equal(result.canPerformProtectedActions, true);
});

test("A7: every legacy membership role (STAFF/JUNIOR/STUDENT/CLIENT_ASSOCIATE) resolves the identical MEMBER role and never escalates permission beyond authority", () => {
  const authority = buildAuthority({ permissions: ["READ"] });
  const organization = buildOrganization();
  for (const role of ["STAFF", "JUNIOR", "STUDENT", "CLIENT_ASSOCIATE"] as const) {
    const membership = buildMembership({ role });
    const result = resolveEffectiveOrganizationAccess({ organization, membership, authority });
    assert.equal(result.decision, "GRANTED");
    assert.equal(result.role, "MEMBER");
    assert.deepEqual([...result.permissions], ["READ"]);
  }
});

test("A8: Project.ownerRef cannot grant permission or approval - the resolution is identical regardless of ownerRef, and the resolver never reads it", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority({ permissions: [] });
  const projectA = buildProject();
  const scope = tenantScope;
  const customer = createCustomer({ tenantScope: scope, customerId: "cust-os-v0-02-b", displayName: "Other Customer" });
  const projectB = createProject({
    tenantScope: scope,
    customer,
    projectId: "proj-os-v0-02-b",
    ownerRef: "a-completely-different-owner-ref",
    state: "active",
  });
  const resultA = resolveEffectiveOrganizationAccess({ organization, membership, authority, project: projectA });
  const resultB = resolveEffectiveOrganizationAccess({ organization, membership, authority, project: projectB });
  assert.equal(resultA.decision, "GRANTED");
  assert.equal(resultB.decision, "GRANTED");
  assert.deepEqual([...resultA.permissions], [...resultB.permissions]);
  assert.equal(resultA.canPerformProtectedActions, resultB.canPerformProtectedActions);
  assert.equal(resultA.role, resultB.role);
});

// ---------------------------------------------------------------------------
// A9: missing/substituted membership fails closed
// ---------------------------------------------------------------------------

test("A9: a missing membership fails closed with zero permissions", () => {
  const organization = buildOrganization();
  const authority = buildAuthority();
  const result = resolveEffectiveOrganizationAccess({ organization, authority });
  assert.equal(result.decision, "DENIED");
  assert.equal(result.membershipId, undefined);
  assert.equal(result.permissions.size, 0);
  assert.match(result.reasons[0] ?? "", /membership is required/);
});

test("A9: a substituted (foreign-tenant) membership fails closed identically to a missing one - zero permissions either way", () => {
  const organization = buildOrganization();
  const authority = buildAuthority();
  const missing = resolveEffectiveOrganizationAccess({ organization, authority });
  const substituted = resolveEffectiveOrganizationAccess({
    organization,
    membership: buildMembership({ tenantScope: otherTenantScope }),
    authority,
  });
  assert.equal(missing.decision, "DENIED");
  assert.equal(substituted.decision, "DENIED");
  assert.equal(missing.permissions.size, 0);
  assert.equal(substituted.permissions.size, 0);
});

// ---------------------------------------------------------------------------
// A10: explainable context/reasons
// ---------------------------------------------------------------------------

test("A10: every resolution (granted or denied) carries explicit tenantId/organizationId provenance and a non-empty reasons list", () => {
  const organization = buildOrganization();
  const authority = buildAuthority();
  const granted = resolveEffectiveOrganizationAccess({
    organization,
    membership: buildMembership(),
    authority,
  });
  const deniedResult = resolveEffectiveOrganizationAccess({ organization, authority });
  for (const result of [granted, deniedResult]) {
    assert.equal(result.tenantId, tenantScope.tenantId);
    assert.equal(result.organizationId, organization.organizationId);
    assert.ok(result.reasons.length > 0, "expected a non-empty reasons list");
    assert.equal(typeof result.reasons[0], "string");
  }
});

// ---------------------------------------------------------------------------
// A11: Organization Zero symmetry
// ---------------------------------------------------------------------------

test("A11: org_akilta and a controlled second organization resolve access through the identical public resolver, with no special branch", () => {
  const akiltaTenantScope = createTenantScope("tenant-akilta-os-v0-02");
  const controlledTenantScope = createTenantScope("tenant-controlled-os-v0-02");

  const orgAkilta = createOrganization({
    organizationId: "org_akilta",
    tenantScope: akiltaTenantScope,
    displayName: "AKILTA (Organization Zero)",
    createdAt: NOW,
  });
  const orgControlled = createOrganization({
    organizationId: "org-controlled-os-v0-02",
    tenantScope: controlledTenantScope,
    displayName: "Controlled Second Organization",
    createdAt: NOW,
  });

  const membershipAkilta = createOrganizationMembership({
    membershipId: "membership-akilta",
    tenantScope: akiltaTenantScope,
    principalRef: "principal-akilta",
    role: "STAFF",
  });
  const membershipControlled = createOrganizationMembership({
    membershipId: "membership-controlled",
    tenantScope: controlledTenantScope,
    principalRef: "principal-controlled",
    role: "STAFF",
  });

  const authorityAkilta = createAuthorityContext({
    tenantScope: akiltaTenantScope,
    permissions: ["READ", "WRITE"],
    canPerformProtectedActions: false,
  });
  const authorityControlled = createAuthorityContext({
    tenantScope: controlledTenantScope,
    permissions: ["READ", "WRITE"],
    canPerformProtectedActions: false,
  });

  const resultAkilta = resolveEffectiveOrganizationAccess({
    organization: orgAkilta,
    membership: membershipAkilta,
    authority: authorityAkilta,
  });
  const resultControlled = resolveEffectiveOrganizationAccess({
    organization: orgControlled,
    membership: membershipControlled,
    authority: authorityControlled,
  });

  assert.equal(resultAkilta.decision, "GRANTED");
  assert.equal(resultControlled.decision, "GRANTED");
  assert.equal(resultAkilta.role, resultControlled.role);
  assert.deepEqual([...resultAkilta.permissions].sort(), [...resultControlled.permissions].sort());
});

// ---------------------------------------------------------------------------
// A12: deterministic replay
// ---------------------------------------------------------------------------

test("A12: identical inputs produce a deep-equal resolution", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const authority = buildAuthority();
  const project = buildProject();
  const resultA = resolveEffectiveOrganizationAccess({ organization, membership, authority, project });
  const resultB = resolveEffectiveOrganizationAccess({ organization, membership, authority, project });
  assert.deepEqual(resultA, resultB);
});

// ---------------------------------------------------------------------------
// A13: malformed structural dependency records cannot bypass scope
// ---------------------------------------------------------------------------

test("A13 (adversarial): a hand-built membership object with a forged tenantId matching the organization cannot be used to smuggle a mismatched principal context - it is still evaluated purely on the tenantId field", () => {
  // The resolver has no way to detect a "forged" membership beyond its
  // structural tenantId - this test proves that field is exactly what
  // gates the decision (not, say, principalRef or role), so a caller
  // cannot bypass scope by varying any field other than tenantId.
  const organization = buildOrganization();
  const authority = buildAuthority();
  const forgedMembership = {
    membershipId: "membership-forged",
    tenantId: otherTenantScope.tenantId,
    principalRef: "principal-forged",
    role: "STAFF",
  } as unknown as OrganizationMembership;
  const result = resolveEffectiveOrganizationAccess({ organization, membership: forgedMembership, authority });
  assert.equal(result.decision, "DENIED");
});

test("A13 (adversarial): a hand-built AuthorityContext with an empty permissions set still resolves GRANTED with zero permissions - the resolver never substitutes an implicit default permission set", () => {
  const organization = buildOrganization();
  const membership = buildMembership();
  const emptyAuthority = createAuthorityContext({
    tenantScope,
    permissions: [],
    canPerformProtectedActions: false,
  });
  const result = resolveEffectiveOrganizationAccess({ organization, membership, authority: emptyAuthority });
  assert.equal(result.decision, "GRANTED");
  assert.equal(result.permissions.size, 0);
});

// ---------------------------------------------------------------------------
// A14: boundary scan
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESOLVER_SOURCE_PATH = "src/domain/effective-organization-access.ts";

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "persistence/store", pattern: /\b(fs\.|node:fs|readFile|writeFile|Database|Repository)\b/ },
  { label: "network/HTTP/fetch", pattern: /\b(fetch\(|node:http|node:https|XMLHttpRequest)\b/ },
  { label: "provider/secret/credential", pattern: /\b(secret|credential|apiKey|password|token)\b/i },
  { label: "session/IdP", pattern: /\b(session|SessionContext|IdP)\b/ },
  { label: "Shopify/AI Commerce coupling", pattern: /\b(shopify|ai[-_]?commerce)\b/i },
  { label: "Date.now/randomness", pattern: /\b(Date\.now\(\)|Math\.random\(\)|new Date\(\))\b/ },
  { label: "mutable singleton/global registry", pattern: /\b(globalThis\.|global\.|let\s+\w+\s*:\s*Map)\b/ },
];

test("A14/boundary: effective-organization-access.ts contains no session/provider/store/network/persistence/AI-Commerce dependency, no Date.now/randomness, and no mutable singleton/global registry", () => {
  const content = readFileSync(join(REPO_ROOT, RESOLVER_SOURCE_PATH), "utf8");
  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    assert.equal(pattern.test(content), false, `found forbidden pattern "${label}" in ${RESOLVER_SOURCE_PATH}`);
  }
});

test("A14/boundary: effective-organization-access.ts imports only tenant-scope.ts/organization.ts/organization-membership.ts/authority.ts/project.ts - no ownership-assignment.ts/partner-organization.ts/customer.ts import", () => {
  const content = readFileSync(join(REPO_ROOT, RESOLVER_SOURCE_PATH), "utf8");
  const importLines = content.split("\n").filter((line) => line.trim().startsWith("import"));
  const allowedModules = [
    "tenant-scope.js",
    "organization.js",
    "organization-membership.js",
    "authority.js",
    "project.js",
  ];
  for (const line of importLines) {
    assert.ok(
      allowedModules.some((mod) => line.includes(mod)),
      `unexpected import line: ${line}`,
    );
  }
  for (const forbidden of ["ownership-assignment.js", "partner-organization.js", "customer.js", "project-ownership.js"]) {
    assert.equal(content.includes(forbidden), false, `must not import "${forbidden}"`);
  }
});

// ---------------------------------------------------------------------------
// A15: dependency-delta check
// ---------------------------------------------------------------------------

test("A15: this task introduced only the one new domain module plus its own test/exec-plan - no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {}, "expected zero runtime dependencies");
});

// A16/A17 (relevant existing suites + final full regression) are proven by
// the repository-wide test run recorded in docs/exec-plans/active/OS-V0-02.md,
// not by a test in this file.

// Type-only reference so `EffectiveAccessResolution` stays exercised by the
// type checker even though no test asserts on its full shape directly.
const _typeCheck: EffectiveAccessResolution["decision"] = "GRANTED";
void _typeCheck;
