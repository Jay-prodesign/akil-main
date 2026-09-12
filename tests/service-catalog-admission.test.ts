import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import { createCustomer } from "../src/domain/customer.js";
import {
  createCommercialOrder,
  resolveDeclaredServiceFromOrder,
  type ServiceCatalogEntry,
} from "../src/domain/commercial-order.js";
import {
  admitServiceCatalogEntry,
  revokeServiceCatalogAdmission,
  resolveTrustedServiceForOrder,
  InvalidServiceCatalogAdmissionError,
  InvalidServiceCatalogAdmissionTransitionError,
} from "../src/domain/service-catalog-admission.js";
import type { AdmittedWorker } from "../src/domain/worker-routing-policy.js";
import { WEBSITE_BUILD_V1_BLUEPRINT } from "../src/fixtures/website-build-v1.js";
import { WEBSITE_BUILD_V1_RECIPE } from "../src/fixtures/website-build-v1-recipe.js";

const tenantScope = createTenantScope("tenant-a");
const customer = createCustomer({ tenantScope, customerId: "cust-1", displayName: "Acme" });

const catalogEntry: ServiceCatalogEntry = {
  serviceRef: "service:known",
  blueprintId: WEBSITE_BUILD_V1_BLUEPRINT.blueprintId,
  blueprintVersion: WEBSITE_BUILD_V1_BLUEPRINT.version,
  recipeId: WEBSITE_BUILD_V1_RECIPE.recipeId,
};

function elevatedWorker(overrides: Partial<AdmittedWorker> = {}): AdmittedWorker {
  return {
    workerId: "authority-1",
    declaredCapabilityRefs: [],
    declaredToolRefs: [],
    declaredPolicyConstraintRefs: [],
    trustStatus: "ADMITTED",
    availability: "AVAILABLE",
    maxRiskLevel: "STANDARD",
    authorityLevel: "ELEVATED",
    costWeight: 0,
    evaluationEvidenceRef: "evidence:worker-eval-1",
    ...overrides,
  };
}

function admit() {
  return admitServiceCatalogEntry({
    catalogEntry,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "evidence:catalog-review-1",
    admittedAt: "2026-01-01T00:00:00.000Z",
  });
}

// --- admitServiceCatalogEntry ---

test("SA1: admitServiceCatalogEntry binds serviceRef/blueprint/version/recipe and is born ADMITTED", () => {
  const admission = admit();
  assert.equal(admission.status, "ADMITTED");
  assert.equal(admission.serviceRef, "service:known");
  assert.equal(admission.blueprintId, WEBSITE_BUILD_V1_BLUEPRINT.blueprintId);
  assert.equal(admission.blueprintVersion, WEBSITE_BUILD_V1_BLUEPRINT.version);
  assert.equal(admission.recipeId, WEBSITE_BUILD_V1_RECIPE.recipeId);
  assert.equal(admission.admittedByAuthorityId, "authority-1");
  assert.equal(admission.evidenceRef, "evidence:catalog-review-1");
});

test("SA2 (adversarial): admitServiceCatalogEntry rejects a catalogEntry.recipeId that does not match the supplied recipe.recipeId", () => {
  const mismatched: ServiceCatalogEntry = {
    ...catalogEntry,
    recipeId: "some-other-recipe-id" as ServiceCatalogEntry["recipeId"],
  };
  assert.throws(
    () =>
      admitServiceCatalogEntry({
        catalogEntry: mismatched,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        authorizingWorker: elevatedWorker(),
        evidenceRef: "evidence:x",
        admittedAt: "2026-01-01T00:00:00.000Z",
      }),
    InvalidServiceCatalogAdmissionError,
  );
});

test("SA3 (Rev102 F2, adversarial): admitServiceCatalogEntry rejects an authorizingWorker that is not trustStatus ADMITTED - an untrusted/revoked caller label cannot become trusted authority", () => {
  for (const trustStatus of ["UNTRUSTED", "REVOKED"] as const) {
    assert.throws(
      () =>
        admitServiceCatalogEntry({
          catalogEntry,
          recipe: WEBSITE_BUILD_V1_RECIPE,
          authorizingWorker: elevatedWorker({ trustStatus }),
          evidenceRef: "evidence:x",
          admittedAt: "2026-01-01T00:00:00.000Z",
        }),
      InvalidServiceCatalogAdmissionError,
    );
  }
});

test("SA3b (Rev102 F2, adversarial): admitServiceCatalogEntry rejects an authorizingWorker that is admitted but not authorityLevel ELEVATED", () => {
  assert.throws(
    () =>
      admitServiceCatalogEntry({
        catalogEntry,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        authorizingWorker: elevatedWorker({ authorityLevel: "STANDARD" }),
        evidenceRef: "evidence:x",
        admittedAt: "2026-01-01T00:00:00.000Z",
      }),
    InvalidServiceCatalogAdmissionError,
  );
});

test("SA4: admitServiceCatalogEntry rejects an empty evidenceRef", () => {
  assert.throws(
    () =>
      admitServiceCatalogEntry({
        catalogEntry,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        authorizingWorker: elevatedWorker(),
        evidenceRef: "",
        admittedAt: "2026-01-01T00:00:00.000Z",
      }),
    InvalidServiceCatalogAdmissionError,
  );
});

test("SA5: admitServiceCatalogEntry rejects an empty admittedAt", () => {
  assert.throws(
    () =>
      admitServiceCatalogEntry({
        catalogEntry,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        authorizingWorker: elevatedWorker(),
        evidenceRef: "evidence:x",
        admittedAt: "",
      }),
    InvalidServiceCatalogAdmissionError,
  );
});

test("SA5b (Rev102 F1, adversarial): admitServiceCatalogEntry rejects a malformed (non-parseable) admittedAt", () => {
  assert.throws(
    () =>
      admitServiceCatalogEntry({
        catalogEntry,
        recipe: WEBSITE_BUILD_V1_RECIPE,
        authorizingWorker: elevatedWorker(),
        evidenceRef: "evidence:x",
        admittedAt: "not-a-real-timestamp",
      }),
    InvalidServiceCatalogAdmissionError,
  );
});

// --- revokeServiceCatalogAdmission ---

test("SA6: revokeServiceCatalogAdmission transitions ADMITTED to REVOKED with a recorded reason", () => {
  const revoked = revokeServiceCatalogAdmission({
    admission: admit(),
    revokedAt: "2026-02-01T00:00:00.000Z",
    reason: "recipe superseded",
  });
  assert.equal(revoked.status, "REVOKED");
  assert.equal(revoked.revokedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(revoked.revokedReason, "recipe superseded");
});

test("SA7 (adversarial double-revoke): revokeServiceCatalogAdmission fails closed on an already-REVOKED admission", () => {
  const revoked = revokeServiceCatalogAdmission({
    admission: admit(),
    revokedAt: "2026-02-01T00:00:00.000Z",
    reason: "first revoke",
  });
  assert.throws(
    () =>
      revokeServiceCatalogAdmission({
        admission: revoked,
        revokedAt: "2026-03-01T00:00:00.000Z",
        reason: "second revoke",
      }),
    InvalidServiceCatalogAdmissionTransitionError,
  );
});

test("SA8 (adversarial temporal integrity): revokeServiceCatalogAdmission rejects a revokedAt strictly before admittedAt", () => {
  assert.throws(
    () =>
      revokeServiceCatalogAdmission({
        admission: admit(),
        revokedAt: "2025-01-01T00:00:00.000Z",
        reason: "backdated",
      }),
    InvalidServiceCatalogAdmissionTransitionError,
  );
});

test("SA9: revokeServiceCatalogAdmission accepts a revokedAt exactly equal to admittedAt (immediate revocation, not 'before')", () => {
  const revoked = revokeServiceCatalogAdmission({
    admission: admit(),
    revokedAt: "2026-01-01T00:00:00.000Z",
    reason: "immediate revoke",
  });
  assert.equal(revoked.status, "REVOKED");
});

test("SA9b (Rev102 F1, adversarial): revokeServiceCatalogAdmission rejects a malformed (non-parseable) revokedAt", () => {
  assert.throws(
    () =>
      revokeServiceCatalogAdmission({
        admission: admit(),
        revokedAt: "not-a-real-timestamp",
        reason: "malformed",
      }),
    InvalidServiceCatalogAdmissionError,
  );
});

test("SA9c (Rev102 F1, adversarial timezone-offset ordering): revokeServiceCatalogAdmission compares chronological instants, not raw strings - a revokedAt with a timezone offset that is the SAME instant as admittedAt is accepted as immediate revocation, not rejected as 'before'", () => {
  // admittedAt is 2026-01-01T00:00:00.000Z; this revokedAt is the identical
  // instant expressed with a +01:00 offset, which sorts LOWER than the
  // admittedAt string lexicographically (the digit '0' in "+01:00" vs the
  // 'Z' the old string comparison would have compared against), so the old
  // buggy `revokedAt < admittedAt` string comparison would have wrongly
  // rejected this as "before" even though it is the exact same instant.
  const revoked = revokeServiceCatalogAdmission({
    admission: admit(),
    revokedAt: "2026-01-01T01:00:00.000+01:00",
    reason: "same instant, different offset",
  });
  assert.equal(revoked.status, "REVOKED");
});

test("SA9d (Rev102 F1, adversarial timezone-offset ordering): a revokedAt that is genuinely 30 minutes before admittedAt in real chronological time is still rejected, even though its raw string sorts AFTER admittedAt lexicographically", () => {
  // admittedAt is 2026-01-01T00:00:00.000Z (ms 1767225600000). This
  // revokedAt string, "2026-01-01T00:30:00.000+01:00", lexicographically
  // sorts AFTER admittedAt (its local-time digits read later), but its
  // +01:00 offset resolves to the real UTC instant 1767223800000 - 30
  // minutes BEFORE admittedAt. The old buggy `revokedAt < admittedAt`
  // string comparison evaluates false here (would have wrongly accepted
  // this as not-before); only chronological (ms) comparison catches it.
  assert.throws(
    () =>
      revokeServiceCatalogAdmission({
        admission: admit(),
        revokedAt: "2026-01-01T00:30:00.000+01:00",
        reason: "actually before, despite sorting later as a string",
      }),
    InvalidServiceCatalogAdmissionTransitionError,
  );
});

// --- resolveTrustedServiceForOrder ---

function orderFor(serviceRef: string) {
  return createCommercialOrder({
    tenantScope,
    customer,
    orderId: "order-1",
    serviceRef,
    placedAt: "2026-01-01T00:00:00.000Z",
  });
}

test("SA10: resolveTrustedServiceForOrder passes through UNRESOLVED_SERVICE unchanged when the declared lookup itself failed", () => {
  const order = orderFor("service:unknown");
  const declaredLookup = resolveDeclaredServiceFromOrder(order, []);
  const resolution = resolveTrustedServiceForOrder({
    order,
    declaredLookup,
    admittedCatalog: [admit()],
  });
  assert.equal(resolution.status, "UNRESOLVED_SERVICE");
});

test("SA11: resolveTrustedServiceForOrder resolves RESOLVED when a matching ADMITTED admission covers the declared lookup exactly", () => {
  const order = orderFor("service:known");
  const declaredLookup = resolveDeclaredServiceFromOrder(order, [catalogEntry]);
  const resolution = resolveTrustedServiceForOrder({
    order,
    declaredLookup,
    admittedCatalog: [admit()],
  });
  assert.equal(resolution.status, "RESOLVED");
  if (resolution.status === "RESOLVED") {
    assert.equal(resolution.admission.serviceRef, "service:known");
  }
});

test("SA12 (the gap-behavior case): resolveTrustedServiceForOrder returns NOT_ADMITTED, never RESOLVED, when the service is declared-resolvable but no admission exists for it", () => {
  const order = orderFor("service:known");
  const declaredLookup = resolveDeclaredServiceFromOrder(order, [catalogEntry]);
  const resolution = resolveTrustedServiceForOrder({
    order,
    declaredLookup,
    admittedCatalog: [],
  });
  assert.equal(resolution.status, "NOT_ADMITTED");
  if (resolution.status === "NOT_ADMITTED") {
    assert.match(resolution.reason, /service:known/);
  }
});

test("SA13 (adversarial): resolveTrustedServiceForOrder never trusts a REVOKED admission - falls back to NOT_ADMITTED", () => {
  const order = orderFor("service:known");
  const declaredLookup = resolveDeclaredServiceFromOrder(order, [catalogEntry]);
  const revoked = revokeServiceCatalogAdmission({
    admission: admit(),
    revokedAt: "2026-02-01T00:00:00.000Z",
    reason: "recipe superseded",
  });
  const resolution = resolveTrustedServiceForOrder({
    order,
    declaredLookup,
    admittedCatalog: [revoked],
  });
  assert.equal(resolution.status, "NOT_ADMITTED");
});

test("SA14 (adversarial stale-version): resolveTrustedServiceForOrder never trusts an admission bound to a different blueprintVersion than the one actually declared-resolved", () => {
  const order = orderFor("service:known");
  const staleEntry: ServiceCatalogEntry = { ...catalogEntry, blueprintVersion: "9.9.9" };
  const declaredLookup = resolveDeclaredServiceFromOrder(order, [staleEntry]);
  // admission still bound to the original (now-superseded) version
  const resolution = resolveTrustedServiceForOrder({
    order,
    declaredLookup,
    admittedCatalog: [admit()],
  });
  assert.equal(resolution.status, "NOT_ADMITTED");
});

test("SA15 (adversarial ambiguity): resolveTrustedServiceForOrder throws, never guesses, when more than one ADMITTED admission matches the same serviceRef/blueprint/version/recipe", () => {
  const order = orderFor("service:known");
  const declaredLookup = resolveDeclaredServiceFromOrder(order, [catalogEntry]);
  const admissionA = admit();
  const admissionB = admitServiceCatalogEntry({
    catalogEntry,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    authorizingWorker: elevatedWorker({ workerId: "authority-2" }),
    evidenceRef: "evidence:catalog-review-2",
    admittedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.throws(
    () =>
      resolveTrustedServiceForOrder({
        order,
        declaredLookup,
        admittedCatalog: [admissionA, admissionB],
      }),
    InvalidServiceCatalogAdmissionError,
  );
});

test("SA16: resolveTrustedServiceForOrder never substitutes a different serviceRef's admission", () => {
  const order = orderFor("service:known");
  const declaredLookup = resolveDeclaredServiceFromOrder(order, [catalogEntry]);
  const otherEntry: ServiceCatalogEntry = { ...catalogEntry, serviceRef: "service:other" };
  const otherAdmission = admitServiceCatalogEntry({
    catalogEntry: otherEntry,
    recipe: WEBSITE_BUILD_V1_RECIPE,
    authorizingWorker: elevatedWorker(),
    evidenceRef: "evidence:x",
    admittedAt: "2026-01-01T00:00:00.000Z",
  });
  const resolution = resolveTrustedServiceForOrder({
    order,
    declaredLookup,
    admittedCatalog: [otherAdmission],
  });
  assert.equal(resolution.status, "NOT_ADMITTED");
});
