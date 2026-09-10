import { test } from "node:test";
import assert from "node:assert/strict";
import {
  proposeChange,
  classifyChangeImpact,
  recordBoundedEnvironmentTest,
  reviewProposal,
  adoptChange,
  rejectChange,
  InvalidGovernedChangeProposalError,
  type GovernedChangeProposal,
} from "../src/domain/governed-evaluation-loop.js";
import {
  createAuthorityContext,
  ProtectedActionNotAuthorizedError,
  type AuthorityContext,
} from "../src/domain/authority.js";
import { createTenantScope } from "../src/domain/tenant-scope.js";

function freshProposal(): GovernedChangeProposal {
  return proposeChange({
    proposalId: "prop-1",
    changeRef: "policy:worker-routing-fallback-order",
    proposedByWorkerId: "claude",
    evalEvidenceRef: "evidence:eval-run-42",
    evalVersionRef: "eval-suite-v3",
  });
}

function authorityWith(canPerformProtectedActions: boolean): AuthorityContext {
  return createAuthorityContext({
    tenantScope: createTenantScope("tenant-akilta"),
    permissions: ["READ", "WRITE", "EXECUTE"],
    canPerformProtectedActions,
  });
}

test("I1: proposeChange always constructs a PROPOSED proposal with no classification/test/review/decision field", () => {
  const proposal = freshProposal();
  assert.equal(proposal.status, "PROPOSED");
  assert.equal(proposal.impactClassification, undefined);
  assert.equal(proposal.regressionOnCriticalBoundary, undefined);
  assert.equal(proposal.safetyRegression, undefined);
  assert.equal(proposal.reviewedByWorkerId, undefined);
  assert.equal(proposal.rollbackPlanRef, undefined);
});

test("I2: proposeChange rejects an empty changeRef/proposedByWorkerId/evalEvidenceRef/evalVersionRef", () => {
  assert.throws(
    () =>
      proposeChange({
        proposalId: "prop-1",
        changeRef: "",
        proposedByWorkerId: "claude",
        evalEvidenceRef: "evidence:1",
        evalVersionRef: "v1",
      }),
    InvalidGovernedChangeProposalError,
  );
  assert.throws(
    () =>
      proposeChange({
        proposalId: "prop-1",
        changeRef: "policy:x",
        proposedByWorkerId: "claude",
        evalEvidenceRef: "  ",
        evalVersionRef: "v1",
      }),
    InvalidGovernedChangeProposalError,
  );
});

test("I3: classifyChangeImpact rejects a non-PROPOSED proposal", () => {
  const proposal = freshProposal();
  const classified = classifyChangeImpact({ proposal, impactClassification: "SAFE" });
  assert.throws(
    () => classifyChangeImpact({ proposal: classified, impactClassification: "MATERIAL" }),
    InvalidGovernedChangeProposalError,
  );
});

test("I4: classifyChangeImpact rejects an invalid impactClassification value", () => {
  const proposal = freshProposal();
  assert.throws(
    () =>
      classifyChangeImpact({
        proposal,
        impactClassification: "UNKNOWN" as unknown as "SAFE",
      }),
    InvalidGovernedChangeProposalError,
  );
});

test("I5: recordBoundedEnvironmentTest rejects a non-CLASSIFIED proposal", () => {
  const proposal = freshProposal();
  assert.throws(
    () =>
      recordBoundedEnvironmentTest({
        proposal,
        regressionOnCriticalBoundary: false,
        safetyRegression: false,
      }),
    InvalidGovernedChangeProposalError,
  );
});

test("I6: recordBoundedEnvironmentTest records a true regression rather than throwing (a real outcome, not an invalid input)", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "SAFE" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: true,
    safetyRegression: false,
  });
  assert.equal(tested.status, "TESTED");
  assert.equal(tested.regressionOnCriticalBoundary, true);
});

test("I7: adoptChange rejects a proposal with a critical-boundary regression, unconditionally", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "SAFE" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: true,
    safetyRegression: false,
  });
  assert.throws(() => adoptChange({ proposal: tested }), InvalidGovernedChangeProposalError);
});

test("I8: adoptChange rejects a proposal with a safety regression, unconditionally (cost cannot override safety)", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "SAFE" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: true,
  });
  assert.throws(() => adoptChange({ proposal: tested }), InvalidGovernedChangeProposalError);
});

test("I9: adoptChange succeeds for a SAFE, clean-tested proposal without requiring review or a rollback plan", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "SAFE" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  const adopted = adoptChange({ proposal: tested });
  assert.equal(adopted.status, "ADOPTED");
  assert.equal(adopted.rollbackPlanRef, undefined);
});

test("I10: adoptChange rejects a MATERIAL proposal that has only been TESTED, not REVIEWED", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "MATERIAL" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  assert.throws(
    () => adoptChange({ proposal: tested, rollbackPlanRef: "rollback:revert-to-v2" }),
    InvalidGovernedChangeProposalError,
  );
});

test("I11: reviewProposal rejects a non-TESTED proposal", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "MATERIAL" });
  assert.throws(
    () => reviewProposal({ proposal: classified, reviewedByWorkerId: "codex" }),
    InvalidGovernedChangeProposalError,
  );
});

test("I12: reviewProposal fail-closed rejects self-review (reviewedByWorkerId equal to proposedByWorkerId)", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "MATERIAL" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  assert.throws(
    () => reviewProposal({ proposal: tested, reviewedByWorkerId: "claude" }),
    InvalidGovernedChangeProposalError,
  );
});

test("I13: adoptChange rejects a MATERIAL, REVIEWED proposal with no rollbackPlanRef", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "MATERIAL" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  const reviewed = reviewProposal({ proposal: tested, reviewedByWorkerId: "codex" });
  assert.throws(() => adoptChange({ proposal: reviewed }), InvalidGovernedChangeProposalError);
});

test("I14: adoptChange succeeds for a MATERIAL, REVIEWED, clean-tested proposal with a rollback plan and granted protected-action authority", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "MATERIAL" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  const reviewed = reviewProposal({ proposal: tested, reviewedByWorkerId: "codex" });
  const adopted = adoptChange({
    proposal: reviewed,
    rollbackPlanRef: "rollback:revert-to-v2",
    authority: authorityWith(true),
  });
  assert.equal(adopted.status, "ADOPTED");
  assert.equal(adopted.rollbackPlanRef, "rollback:revert-to-v2");
  assert.equal(adopted.reviewedByWorkerId, "codex");
});

test("I18: adoptChange fail-closed rejects a MATERIAL, REVIEWED proposal with no AuthorityContext supplied at all", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "MATERIAL" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  const reviewed = reviewProposal({ proposal: tested, reviewedByWorkerId: "codex" });
  assert.throws(
    () => adoptChange({ proposal: reviewed, rollbackPlanRef: "rollback:revert-to-v2" }),
    InvalidGovernedChangeProposalError,
  );
});

test("I19: adoptChange fail-closed rejects a MATERIAL, REVIEWED proposal whose supplied AuthorityContext lacks canPerformProtectedActions - independent review alone is not decision authority", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "MATERIAL" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  const reviewed = reviewProposal({ proposal: tested, reviewedByWorkerId: "codex" });
  assert.throws(
    () =>
      adoptChange({
        proposal: reviewed,
        rollbackPlanRef: "rollback:revert-to-v2",
        authority: authorityWith(false),
      }),
    ProtectedActionNotAuthorizedError,
  );
});

test("I20: a SAFE proposal's adoption does not require any AuthorityContext at all", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "SAFE" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  const adopted = adoptChange({ proposal: tested });
  assert.equal(adopted.status, "ADOPTED");
});

test("I15: rejectChange works from PROPOSED, CLASSIFIED, TESTED, and REVIEWED, and refuses an empty rejectionReason", () => {
  const proposed = freshProposal();
  assert.equal(rejectChange({ proposal: proposed, rejectionReason: "not aligned" }).status, "REJECTED");

  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "SAFE" });
  assert.equal(rejectChange({ proposal: classified, rejectionReason: "not aligned" }).status, "REJECTED");

  assert.throws(
    () => rejectChange({ proposal: freshProposal(), rejectionReason: "" }),
    InvalidGovernedChangeProposalError,
  );
});

test("I16: rejectChange refuses to re-reject an already-ADOPTED or already-REJECTED proposal", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "SAFE" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  const adopted = adoptChange({ proposal: tested });
  assert.throws(
    () => rejectChange({ proposal: adopted, rejectionReason: "too late" }),
    InvalidGovernedChangeProposalError,
  );

  const rejected = rejectChange({ proposal: freshProposal(), rejectionReason: "no" });
  assert.throws(
    () => rejectChange({ proposal: rejected, rejectionReason: "still no" }),
    InvalidGovernedChangeProposalError,
  );
});

test("I17: evalEvidenceRef/evalVersionRef are preserved verbatim through every lifecycle transition", () => {
  const classified = classifyChangeImpact({ proposal: freshProposal(), impactClassification: "MATERIAL" });
  const tested = recordBoundedEnvironmentTest({
    proposal: classified,
    regressionOnCriticalBoundary: false,
    safetyRegression: false,
  });
  const reviewed = reviewProposal({ proposal: tested, reviewedByWorkerId: "codex" });
  const adopted = adoptChange({
    proposal: reviewed,
    rollbackPlanRef: "rollback:revert-to-v2",
    authority: authorityWith(true),
  });
  for (const stage of [classified, tested, reviewed, adopted]) {
    assert.equal(stage.evalEvidenceRef, "evidence:eval-run-42");
    assert.equal(stage.evalVersionRef, "eval-suite-v3");
  }
});
