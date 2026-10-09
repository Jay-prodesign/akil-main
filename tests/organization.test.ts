import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import { createOrganizationMembership } from "../src/domain/organization-membership.js";
import { createPartnerOrganization } from "../src/domain/partner-organization.js";
import {
  createOrganization,
  activateOrganization,
  suspendOrganization,
  InvalidOrganizationError,
  InvalidOrganizationTransitionError,
  type Organization,
} from "../src/domain/organization.js";

const tenantScope = createTenantScope("tenant-os-v0-01");
const otherTenantScope = createTenantScope("tenant-os-v0-01-other");

const NOW = "2026-09-24T00:00:00.000Z";

function baseOrgInput(overrides: {
  organizationId?: unknown;
  tenantScope?: typeof tenantScope;
  displayName?: unknown;
  createdAt?: unknown;
} = {}) {
  return {
    organizationId: overrides.organizationId ?? "org-reference-1",
    tenantScope: overrides.tenantScope ?? tenantScope,
    displayName: overrides.displayName ?? "Reference Organization",
    createdAt: overrides.createdAt ?? NOW,
  };
}

// ---------------------------------------------------------------------------
// O1/O2/O3: construction
// ---------------------------------------------------------------------------

test("O1: valid Organization construction binds identity to the exact supplied TenantScope and starts BOOTSTRAPPING", () => {
  const org = createOrganization(baseOrgInput());
  assert.equal(org.organizationId, "org-reference-1");
  assert.equal(org.tenantId, tenantScope.tenantId);
  assert.equal(org.displayName, "Reference Organization");
  assert.equal(org.state, "BOOTSTRAPPING");
  assert.equal(org.createdAt, NOW);
  assert.equal(org.activatedAt, undefined);
  assert.equal(org.suspendedAt, undefined);
});

test("O2 (adversarial): createOrganization rejects an empty organizationId", () => {
  assert.throws(
    () => createOrganization(baseOrgInput({ organizationId: "" })),
    InvalidOrganizationError,
  );
});

test("O2 (adversarial): createOrganization rejects a whitespace-only organizationId", () => {
  assert.throws(
    () => createOrganization(baseOrgInput({ organizationId: "   " })),
    InvalidOrganizationError,
  );
});

test("O2 (adversarial): createOrganization rejects an organizationId with leading/trailing whitespace", () => {
  assert.throws(
    () => createOrganization(baseOrgInput({ organizationId: " org-1 " })),
    InvalidOrganizationError,
  );
});

test("O2 (adversarial): createOrganization rejects a blank displayName", () => {
  assert.throws(
    () => createOrganization(baseOrgInput({ displayName: "" })),
    InvalidOrganizationError,
  );
});

test("O2 (adversarial): createOrganization rejects a non-string displayName", () => {
  assert.throws(
    () => createOrganization(baseOrgInput({ displayName: 42 })),
    InvalidOrganizationError,
  );
});

test("O2 (adversarial): createOrganization rejects an empty createdAt", () => {
  assert.throws(
    () => createOrganization(baseOrgInput({ createdAt: "" })),
    InvalidOrganizationError,
  );
});

test("O2 (adversarial): createOrganization rejects a malformed (non-parseable) createdAt", () => {
  assert.throws(
    () => createOrganization(baseOrgInput({ createdAt: "not-a-real-timestamp" })),
    InvalidOrganizationError,
  );
});

test("O3 (adversarial tenant distinction): the same-looking organizationId under a different TenantScope produces a tenant-distinct Organization value", () => {
  const orgA = createOrganization(baseOrgInput({ organizationId: "org-shared-id", tenantScope }));
  const orgB = createOrganization(
    baseOrgInput({ organizationId: "org-shared-id", tenantScope: otherTenantScope }),
  );
  assert.equal(orgA.organizationId, orgB.organizationId);
  assert.notEqual(orgA.tenantId, orgB.tenantId);
  assert.notDeepEqual(orgA, orgB);
});

// ---------------------------------------------------------------------------
// O4/O5/O6/O7: lifecycle transitions
// ---------------------------------------------------------------------------

test("O4: activation succeeds only from BOOTSTRAPPING, records a valid monotonic activatedAt, and preserves the original creation record immutably", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" });
  assert.equal(activated.state, "ACTIVE");
  assert.equal(activated.activatedAt, "2026-09-24T01:00:00.000Z");
  // original value is untouched (immutability) - preserved provenance fields.
  assert.equal(org.state, "BOOTSTRAPPING");
  assert.equal(org.activatedAt, undefined);
  assert.equal(activated.organizationId, org.organizationId);
  assert.equal(activated.tenantId, org.tenantId);
  assert.equal(activated.displayName, org.displayName);
  assert.equal(activated.createdAt, org.createdAt);
});

test("O4 (adversarial): activatedAt exactly equal to createdAt is accepted (immediate activation, not 'before')", () => {
  const org = createOrganization(baseOrgInput({ createdAt: NOW }));
  const activated = activateOrganization({ organization: org, activatedAt: NOW });
  assert.equal(activated.state, "ACTIVE");
});

test("O5: suspension succeeds only from ACTIVE, records a valid monotonic suspendedAt, and preserves prior values immutably", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" });
  const suspended = suspendOrganization({ organization: activated, suspendedAt: "2026-09-24T02:00:00.000Z" });
  assert.equal(suspended.state, "SUSPENDED");
  assert.equal(suspended.suspendedAt, "2026-09-24T02:00:00.000Z");
  assert.equal(suspended.activatedAt, activated.activatedAt);
  assert.equal(suspended.createdAt, activated.createdAt);
  assert.equal(activated.state, "ACTIVE");
  assert.equal(activated.suspendedAt, undefined);
});

test("O5 (adversarial): suspendedAt exactly equal to activatedAt is accepted (immediate suspension, not 'before')", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" });
  const suspended = suspendOrganization({ organization: activated, suspendedAt: "2026-09-24T01:00:00.000Z" });
  assert.equal(suspended.state, "SUSPENDED");
});

test("O6 (adversarial): activateOrganization rejects an activatedAt strictly before createdAt", () => {
  const org = createOrganization(baseOrgInput({ createdAt: "2026-09-24T02:00:00.000Z" }));
  assert.throws(
    () => activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("O6 (adversarial): suspendOrganization rejects a suspendedAt strictly before activatedAt", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T02:00:00.000Z" });
  assert.throws(
    () => suspendOrganization({ organization: activated, suspendedAt: "2026-09-24T01:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("O6 (adversarial): activateOrganization rejects a malformed activatedAt", () => {
  const org = createOrganization(baseOrgInput());
  assert.throws(
    () => activateOrganization({ organization: org, activatedAt: "not-a-real-timestamp" }),
    InvalidOrganizationError,
  );
});

test("O6 (adversarial): suspendOrganization rejects a malformed suspendedAt", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" });
  assert.throws(
    () => suspendOrganization({ organization: activated, suspendedAt: "not-a-real-timestamp" }),
    InvalidOrganizationError,
  );
});

test("O7 (adversarial): double activation fails closed", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" });
  assert.throws(
    () => activateOrganization({ organization: activated, activatedAt: "2026-09-24T02:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("O7 (adversarial): activation from SUSPENDED fails closed", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" });
  const suspended = suspendOrganization({ organization: activated, suspendedAt: "2026-09-24T02:00:00.000Z" });
  assert.throws(
    () => activateOrganization({ organization: suspended, activatedAt: "2026-09-24T03:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("O7 (adversarial): suspension from BOOTSTRAPPING fails closed", () => {
  const org = createOrganization(baseOrgInput());
  assert.throws(
    () => suspendOrganization({ organization: org, suspendedAt: "2026-09-24T01:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("O7 (adversarial): double suspension fails closed", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" });
  const suspended = suspendOrganization({ organization: activated, suspendedAt: "2026-09-24T02:00:00.000Z" });
  assert.throws(
    () => suspendOrganization({ organization: suspended, suspendedAt: "2026-09-24T03:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

// ---------------------------------------------------------------------------
// Rev126 F1 (adversarial, factory-bypass lifecycle-record revalidation):
// Organization is an exported structural interface, so a caller can
// hand-build a value with an impossible lifecycle-field combination
// instead of reaching that shape only through createOrganization/
// activateOrganization/suspendOrganization. Every forged record below must
// be rejected by the FULL pre-existing-record revalidation, not merely by
// the newly-supplied transition timestamp.
// ---------------------------------------------------------------------------

test("Rev126 F1 (adversarial): a hand-built BOOTSTRAPPING record already carrying a stale activatedAt cannot be activated", () => {
  const forged = {
    organizationId: "org-forged-1",
    tenantId: tenantScope.tenantId,
    displayName: "Forged Organization",
    state: "BOOTSTRAPPING",
    createdAt: NOW,
    activatedAt: "2026-09-24T00:30:00.000Z",
  } as unknown as Organization;
  assert.throws(
    () => activateOrganization({ organization: forged, activatedAt: "2026-09-24T01:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("Rev126 F1 (adversarial): a hand-built BOOTSTRAPPING record already carrying a stale suspendedAt cannot be activated - the field can no longer silently survive object-spread into the resulting ACTIVE value", () => {
  const forged = {
    organizationId: "org-forged-2",
    tenantId: tenantScope.tenantId,
    displayName: "Forged Organization",
    state: "BOOTSTRAPPING",
    createdAt: NOW,
    suspendedAt: "2026-09-24T00:30:00.000Z",
  } as unknown as Organization;
  assert.throws(
    () => activateOrganization({ organization: forged, activatedAt: "2026-09-24T01:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("Rev126 F1 (adversarial): an ACTIVE record with a missing activatedAt cannot be suspended", () => {
  const forged = {
    organizationId: "org-forged-3",
    tenantId: tenantScope.tenantId,
    displayName: "Forged Organization",
    state: "ACTIVE",
    createdAt: NOW,
  } as unknown as Organization;
  assert.throws(
    () => suspendOrganization({ organization: forged, suspendedAt: "2026-09-24T01:00:00.000Z" }),
    InvalidOrganizationError,
  );
});

test("Rev126 F1 (adversarial): an ACTIVE record with a malformed activatedAt cannot be suspended", () => {
  const forged = {
    organizationId: "org-forged-4",
    tenantId: tenantScope.tenantId,
    displayName: "Forged Organization",
    state: "ACTIVE",
    createdAt: NOW,
    activatedAt: "not-a-real-timestamp",
  } as unknown as Organization;
  assert.throws(
    () => suspendOrganization({ organization: forged, suspendedAt: "2026-09-24T01:00:00.000Z" }),
    InvalidOrganizationError,
  );
});

test("Rev126 F1 (adversarial): an ACTIVE record whose activatedAt predates its own createdAt cannot be suspended, even though the new suspendedAt would otherwise compare correctly against activatedAt alone", () => {
  const forged = {
    organizationId: "org-forged-5",
    tenantId: tenantScope.tenantId,
    displayName: "Forged Organization",
    state: "ACTIVE",
    createdAt: "2026-09-24T02:00:00.000Z",
    activatedAt: "2026-09-24T01:00:00.000Z",
  } as unknown as Organization;
  // suspendedAt (03:00) is >= activatedAt (01:00) - only the createdAt<=
  // activatedAt revalidation this correction adds catches this forgery.
  assert.throws(
    () => suspendOrganization({ organization: forged, suspendedAt: "2026-09-24T03:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("Rev126 F1 (adversarial): an ACTIVE record already carrying a stale suspendedAt cannot be suspended again", () => {
  const forged = {
    organizationId: "org-forged-6",
    tenantId: tenantScope.tenantId,
    displayName: "Forged Organization",
    state: "ACTIVE",
    createdAt: NOW,
    activatedAt: "2026-09-24T01:00:00.000Z",
    suspendedAt: "2026-09-24T01:30:00.000Z",
  } as unknown as Organization;
  assert.throws(
    () => suspendOrganization({ organization: forged, suspendedAt: "2026-09-24T02:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

test("Rev126 F1 (adversarial): a hand-built SUSPENDED record with internally-inconsistent fields still cannot be advanced by either public transition - the state guard alone rejects it", () => {
  const forged = {
    organizationId: "org-forged-7",
    tenantId: tenantScope.tenantId,
    displayName: "Forged Organization",
    state: "SUSPENDED",
    createdAt: "2026-09-24T03:00:00.000Z",
    activatedAt: "2026-09-24T01:00:00.000Z",
    suspendedAt: "2026-09-24T00:00:00.000Z",
  } as unknown as Organization;
  assert.throws(
    () => activateOrganization({ organization: forged, activatedAt: "2026-09-24T04:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
  assert.throws(
    () => suspendOrganization({ organization: forged, suspendedAt: "2026-09-24T04:00:00.000Z" }),
    InvalidOrganizationTransitionError,
  );
});

// ---------------------------------------------------------------------------
// O8: determinism
// ---------------------------------------------------------------------------

test("O8: identical creation and transition inputs produce deep-equal Organization values", () => {
  const inputA = baseOrgInput();
  const inputB = baseOrgInput();
  const orgA = createOrganization(inputA);
  const orgB = createOrganization(inputB);
  assert.deepEqual(orgA, orgB);

  const activatedA = activateOrganization({ organization: orgA, activatedAt: "2026-09-24T01:00:00.000Z" });
  const activatedB = activateOrganization({ organization: orgB, activatedAt: "2026-09-24T01:00:00.000Z" });
  assert.deepEqual(activatedA, activatedB);

  const suspendedA = suspendOrganization({ organization: activatedA, suspendedAt: "2026-09-24T02:00:00.000Z" });
  const suspendedB = suspendOrganization({ organization: activatedB, suspendedAt: "2026-09-24T02:00:00.000Z" });
  assert.deepEqual(suspendedA, suspendedB);
});

// ---------------------------------------------------------------------------
// O9: Organization Zero witness
// ---------------------------------------------------------------------------

test("O9: org_akilta and a controlled second Organization are built/activated through the identical public contract, with no special runtime branch", () => {
  const akiltaTenantScope = createTenantScope("tenant-akilta");
  const controlledTenantScope = createTenantScope("tenant-controlled-org-1");

  const orgAkilta = createOrganization({
    organizationId: "org_akilta",
    tenantScope: akiltaTenantScope,
    displayName: "AKILTA (Organization Zero)",
    createdAt: NOW,
  });
  const controlledOrg = createOrganization({
    organizationId: "org-controlled-1",
    tenantScope: controlledTenantScope,
    displayName: "Controlled Second Organization",
    createdAt: NOW,
  });

  // Structurally identical shape - same fields, same factory, same
  // transition functions. No isSystem/isPlatform/bypass field exists on
  // either value (TypeScript's own Organization type has no such field,
  // and this asserts it is also absent at runtime).
  assert.deepEqual(Object.keys(orgAkilta).sort(), Object.keys(controlledOrg).sort());
  assert.equal("isSystem" in orgAkilta, false);
  assert.equal("isPlatform" in orgAkilta, false);
  assert.equal("bypass" in orgAkilta, false);
  assert.equal("superuser" in orgAkilta, false);

  const activatedAkilta = activateOrganization({ organization: orgAkilta, activatedAt: "2026-09-24T01:00:00.000Z" });
  const activatedControlled = activateOrganization({
    organization: controlledOrg,
    activatedAt: "2026-09-24T01:00:00.000Z",
  });
  assert.equal(activatedAkilta.state, "ACTIVE");
  assert.equal(activatedControlled.state, "ACTIVE");
});

// ---------------------------------------------------------------------------
// O10/O11/O12/O13: non-conflation with existing primitives
// ---------------------------------------------------------------------------

test("O10: an Organization and a Customer coexist in one TenantScope without identity conflation", () => {
  const org = createOrganization(baseOrgInput());
  const customer = createCustomer({
    tenantScope,
    customerId: "cust-os-v0-01",
    displayName: "A Customer in the same tenant",
  });
  assert.equal(org.tenantId, customer.tenantId);
  assert.equal("customerId" in org, false);
  assert.equal("learningEligibility" in org, false);
  assert.notEqual(
    (org as unknown as { organizationId: string }).organizationId,
    (customer as unknown as { customerId: string }).customerId,
  );
});

test("O11: OrganizationMembership remains separately constructible against the same TenantScope, and neither object grants the other's semantics by presence alone", () => {
  const org = createOrganization(baseOrgInput());
  const membership = createOrganizationMembership({
    membershipId: "membership-os-v0-01",
    tenantScope,
    principalRef: "principal-1",
    role: "STAFF",
  });
  assert.equal(org.tenantId, membership.tenantId);
  assert.equal("members" in org, false);
  assert.equal("roles" in org, false);
  assert.equal("assignments" in org, false);
  assert.equal("role" in org, false);
});

test("O12: creating/activating an Organization cannot manufacture AuthorityContext - no permissions/authorization field exists", () => {
  const org = createOrganization(baseOrgInput());
  const activated = activateOrganization({ organization: org, activatedAt: "2026-09-24T01:00:00.000Z" });
  assert.equal("permissions" in org, false);
  assert.equal("authority" in org, false);
  assert.equal("canPerformProtectedActions" in org, false);
  assert.equal("permissions" in activated, false);
  assert.equal("authority" in activated, false);
});

test("O13: PartnerOrganization remains separate - Organization carries no partner relationship type or partner-access semantics", () => {
  const org = createOrganization(baseOrgInput());
  const partnerOrg = createPartnerOrganization({
    partnerOrganizationId: "partner-os-v0-01",
    tenantScope,
    relationshipType: "AGENCY",
  });
  assert.equal(org.tenantId, partnerOrg.tenantId);
  assert.equal("relationshipType" in org, false);
  assert.equal("partnerOrganizationId" in org, false);
});

// ---------------------------------------------------------------------------
// O14: boundary scan
// ---------------------------------------------------------------------------

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORGANIZATION_SOURCE_PATH = "src/domain/organization.ts";

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "persistence/store", pattern: /\b(fs\.|node:fs|readFile|writeFile|Database|Repository)\b/ },
  { label: "network/HTTP/fetch", pattern: /\b(fetch\(|node:http|node:https|XMLHttpRequest)\b/ },
  { label: "provider/secret/credential", pattern: /\b(secret|credential|apiKey|password|token)\b/i },
  { label: "Shopify/AI Commerce coupling", pattern: /\b(shopify|ai[-_]?commerce)\b/i },
  { label: "Date.now/randomness", pattern: /\b(Date\.now\(\)|Math\.random\(\)|new Date\(\))\b/ },
  { label: "mutable singleton/global registry", pattern: /\b(globalThis\.|global\.|let\s+\w+\s*:\s*Map)\b/ },
];

test("O14/boundary: organization.ts contains no persistence/store/network/provider/secret/Shopify/AI-Commerce dependency, no Date.now/randomness, and no mutable singleton/global registry", () => {
  const content = readFileSync(join(REPO_ROOT, ORGANIZATION_SOURCE_PATH), "utf8");
  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    assert.equal(pattern.test(content), false, `found forbidden pattern "${label}" in ${ORGANIZATION_SOURCE_PATH}`);
  }
});

test("O14/boundary: organization.ts imports only tenant-scope.ts - no authority.ts/customer.ts/partner-organization.ts/organization-membership.ts/ownership-assignment.ts import", () => {
  const content = readFileSync(join(REPO_ROOT, ORGANIZATION_SOURCE_PATH), "utf8");
  const importLines = content.split("\n").filter((line) => line.trim().startsWith("import"));
  assert.equal(importLines.length, 1, `expected exactly one import statement, found ${importLines.length}`);
  assert.match(importLines[0] ?? "", /tenant-scope\.js/);
  for (const forbidden of [
    "authority.js",
    "customer.js",
    "partner-organization.js",
    "organization-membership.js",
    "ownership-assignment.js",
  ]) {
    assert.equal(content.includes(forbidden), false, `organization.ts must not import "${forbidden}"`);
  }
});

// ---------------------------------------------------------------------------
// O15: dependency-delta check
// ---------------------------------------------------------------------------

test("O15: this task introduced only the one new domain module plus its own test/exec-plan - no new runtime dependency", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies ?? {}, {}, "expected zero runtime dependencies");
});

// O16 (full regression) is proven by the repository-wide test run recorded
// in docs/exec-plans/active/OS-V0-01.md, not by a test in this file.
