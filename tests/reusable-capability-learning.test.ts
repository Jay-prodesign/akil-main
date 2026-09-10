import { test } from "node:test";
import assert from "node:assert/strict";
import { createTenantScope } from "../src/domain/tenant-scope.js";
import {
  observeCapabilityPattern,
  recordAdditionalObservation,
  promoteToCandidate,
  evaluateCandidate,
  promoteToReusable,
  InvalidReusableCapabilityCandidateError,
} from "../src/domain/reusable-capability-learning.js";

const tenantA = createTenantScope("akilta-tenant-a");
const tenantB = createTenantScope("akilta-tenant-b");
const observedAt = "2026-09-10T10:00:00.000Z";
const laterObservedAt = "2026-09-10T11:00:00.000Z";

function freshCandidate() {
  return observeCapabilityPattern({
    capabilityCandidateId: "cap-1",
    patternRef: "pattern:website-build-seo-checklist",
    tenantScope: tenantA,
    projectRef: "project-alpha",
    observedAt,
  });
}

test("G1: observeCapabilityPattern always constructs an OBSERVED_PATTERN candidate with exactly one observation", () => {
  const candidate = freshCandidate();
  assert.equal(candidate.status, "OBSERVED_PATTERN");
  assert.equal(candidate.observationRefs?.length, 1);
  assert.equal(candidate.observationRefs?.[0]?.tenantScope.tenantId, "akilta-tenant-a");
  assert.equal(candidate.evalEvidenceRef, undefined);
  assert.equal(candidate.evaluationOutcome, undefined);
});

test("G2: observeCapabilityPattern rejects an empty capabilityCandidateId/patternRef/projectRef", () => {
  assert.throws(
    () =>
      observeCapabilityPattern({
        capabilityCandidateId: "",
        patternRef: "pattern:x",
        tenantScope: tenantA,
        projectRef: "project-alpha",
        observedAt,
      }),
    InvalidReusableCapabilityCandidateError,
  );
  assert.throws(
    () =>
      observeCapabilityPattern({
        capabilityCandidateId: "cap-1",
        patternRef: "  ",
        tenantScope: tenantA,
        projectRef: "project-alpha",
        observedAt,
      }),
    InvalidReusableCapabilityCandidateError,
  );
});

test("G3: observeCapabilityPattern rejects an invalid observedAt timestamp", () => {
  assert.throws(
    () =>
      observeCapabilityPattern({
        capabilityCandidateId: "cap-1",
        patternRef: "pattern:x",
        tenantScope: tenantA,
        projectRef: "project-alpha",
        observedAt: "not-a-date",
      }),
    InvalidReusableCapabilityCandidateError,
  );
});

test("G4: promoteToCandidate rejects a candidate with only a single observation (one artifact never becomes a product by assertion)", () => {
  const candidate = freshCandidate();
  assert.throws(() => promoteToCandidate(candidate), InvalidReusableCapabilityCandidateError);
});

test("G5: recordAdditionalObservation rejects a repeat observation from the same tenantScope/projectRef", () => {
  const candidate = freshCandidate();
  assert.throws(
    () =>
      recordAdditionalObservation({
        candidate,
        tenantScope: tenantA,
        projectRef: "project-alpha",
        observedAt: laterObservedAt,
      }),
    InvalidReusableCapabilityCandidateError,
  );
});

test("G6: promoteToCandidate rejects two observations from the same tenant even in different projects", () => {
  let candidate = freshCandidate();
  candidate = recordAdditionalObservation({
    candidate,
    tenantScope: tenantA,
    projectRef: "project-beta",
    observedAt: laterObservedAt,
  });
  assert.equal(candidate.observationRefs?.length, 2);
  assert.throws(() => promoteToCandidate(candidate), InvalidReusableCapabilityCandidateError);
});

test("G7: promoteToCandidate succeeds once observations span at least two distinct tenants", () => {
  let candidate = freshCandidate();
  candidate = recordAdditionalObservation({
    candidate,
    tenantScope: tenantB,
    projectRef: "project-gamma",
    observedAt: laterObservedAt,
  });
  const promoted = promoteToCandidate(candidate);
  assert.equal(promoted.status, "CANDIDATE");
  assert.equal(promoted.observationRefs?.length, 2);
});

test("G8: recordAdditionalObservation rejects once the candidate has left OBSERVED_PATTERN", () => {
  let candidate = freshCandidate();
  candidate = recordAdditionalObservation({
    candidate,
    tenantScope: tenantB,
    projectRef: "project-gamma",
    observedAt: laterObservedAt,
  });
  const promoted = promoteToCandidate(candidate);
  assert.throws(
    () =>
      recordAdditionalObservation({
        candidate: promoted,
        tenantScope: tenantA,
        projectRef: "project-delta",
        observedAt: laterObservedAt,
      }),
    InvalidReusableCapabilityCandidateError,
  );
});

function twoTenantCandidate() {
  let candidate = freshCandidate();
  candidate = recordAdditionalObservation({
    candidate,
    tenantScope: tenantB,
    projectRef: "project-gamma",
    observedAt: laterObservedAt,
  });
  return promoteToCandidate(candidate);
}

test("G9: evaluateCandidate rejects an OBSERVED_PATTERN candidate (only CANDIDATE can be evaluated)", () => {
  const candidate = freshCandidate();
  assert.throws(
    () =>
      evaluateCandidate({ candidate, evalEvidenceRef: "evidence:eval-1", outcome: "REUSABLE" }),
    InvalidReusableCapabilityCandidateError,
  );
});

test("G10: evaluateCandidate rejects an empty evalEvidenceRef", () => {
  const candidate = twoTenantCandidate();
  assert.throws(
    () => evaluateCandidate({ candidate, evalEvidenceRef: "", outcome: "REUSABLE" }),
    InvalidReusableCapabilityCandidateError,
  );
});

test("G11: evaluateCandidate with REUSABLE outcome transitions to EVALUATED and records the outcome", () => {
  const candidate = twoTenantCandidate();
  const evaluated = evaluateCandidate({
    candidate,
    evalEvidenceRef: "evidence:eval-1",
    outcome: "REUSABLE",
  });
  assert.equal(evaluated.status, "EVALUATED");
  assert.equal(evaluated.evaluationOutcome, "REUSABLE");
  assert.equal(evaluated.evalEvidenceRef, "evidence:eval-1");
});

test("G12: evaluateCandidate with NOT_REUSABLE outcome transitions to EVALUATED and records the negative outcome", () => {
  const candidate = twoTenantCandidate();
  const evaluated = evaluateCandidate({
    candidate,
    evalEvidenceRef: "evidence:eval-2",
    outcome: "NOT_REUSABLE",
  });
  assert.equal(evaluated.status, "EVALUATED");
  assert.equal(evaluated.evaluationOutcome, "NOT_REUSABLE");
});

test("G13: promoteToReusable rejects a CANDIDATE that was never evaluated", () => {
  const candidate = twoTenantCandidate();
  assert.throws(
    () =>
      promoteToReusable({
        candidate,
        licenseOrIpNote: "first-party, no third-party content",
        reusableAssetVersion: "1.0.0",
      }),
    InvalidReusableCapabilityCandidateError,
  );
});

test("G14: promoteToReusable rejects an EVALUATED candidate whose outcome is NOT_REUSABLE", () => {
  const candidate = twoTenantCandidate();
  const evaluated = evaluateCandidate({
    candidate,
    evalEvidenceRef: "evidence:eval-2",
    outcome: "NOT_REUSABLE",
  });
  assert.throws(
    () =>
      promoteToReusable({
        candidate: evaluated,
        licenseOrIpNote: "first-party, no third-party content",
        reusableAssetVersion: "1.0.0",
      }),
    InvalidReusableCapabilityCandidateError,
  );
});

test("G15: promoteToReusable rejects an empty licenseOrIpNote or reusableAssetVersion", () => {
  const candidate = twoTenantCandidate();
  const evaluated = evaluateCandidate({
    candidate,
    evalEvidenceRef: "evidence:eval-1",
    outcome: "REUSABLE",
  });
  assert.throws(
    () =>
      promoteToReusable({
        candidate: evaluated,
        licenseOrIpNote: "",
        reusableAssetVersion: "1.0.0",
      }),
    InvalidReusableCapabilityCandidateError,
  );
  assert.throws(
    () =>
      promoteToReusable({
        candidate: evaluated,
        licenseOrIpNote: "first-party, no third-party content",
        reusableAssetVersion: "  ",
      }),
    InvalidReusableCapabilityCandidateError,
  );
});

test("G16: promoteToReusable succeeds on a REUSABLE-evaluated candidate and strips observationRefs (customer/tenant provenance)", () => {
  const candidate = twoTenantCandidate();
  const evaluated = evaluateCandidate({
    candidate,
    evalEvidenceRef: "evidence:eval-1",
    outcome: "REUSABLE",
  });
  const approved = promoteToReusable({
    candidate: evaluated,
    licenseOrIpNote: "first-party, no third-party content",
    reusableAssetVersion: "1.0.0",
  });
  assert.equal(approved.status, "APPROVED_REUSABLE");
  assert.equal(approved.licenseOrIpNote, "first-party, no third-party content");
  assert.equal(approved.reusableAssetVersion, "1.0.0");
  assert.equal(approved.observationRefs, undefined);
  // provenance-independent fields are preserved
  assert.equal(approved.capabilityCandidateId, "cap-1");
  assert.equal(approved.patternRef, "pattern:website-build-seo-checklist");
  assert.equal(approved.evalEvidenceRef, "evidence:eval-1");
  assert.equal(approved.evaluationOutcome, "REUSABLE");
});

test("G17: the full lifecycle round-trip is deterministic and produces no intermediate mutation of prior objects", () => {
  const observed = freshCandidate();
  const withSecondObservation = recordAdditionalObservation({
    candidate: observed,
    tenantScope: tenantB,
    projectRef: "project-gamma",
    observedAt: laterObservedAt,
  });
  const candidateStage = promoteToCandidate(withSecondObservation);
  const evaluated = evaluateCandidate({
    candidate: candidateStage,
    evalEvidenceRef: "evidence:eval-1",
    outcome: "REUSABLE",
  });
  const approved = promoteToReusable({
    candidate: evaluated,
    licenseOrIpNote: "first-party",
    reusableAssetVersion: "1.0.0",
  });
  // original OBSERVED_PATTERN object is untouched (no in-place mutation)
  assert.equal(observed.status, "OBSERVED_PATTERN");
  assert.equal(observed.observationRefs?.length, 1);
  assert.equal(withSecondObservation.status, "OBSERVED_PATTERN");
  assert.equal(candidateStage.status, "CANDIDATE");
  assert.equal(evaluated.status, "EVALUATED");
  assert.equal(approved.status, "APPROVED_REUSABLE");
});
