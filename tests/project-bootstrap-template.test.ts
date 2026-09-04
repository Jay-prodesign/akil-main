import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveProjectBootstrapPlan,
  InvalidProjectBootstrapRequestError,
  type BootstrapTemplateAsset,
  type BootstrapTemplateSource,
} from "../src/domain/project-bootstrap-template.js";

function asset(overrides: Partial<BootstrapTemplateAsset> = {}): BootstrapTemplateAsset {
  return {
    kind: "AGENT_NAVIGATION",
    sourceProjectRef: "akilta",
    sourceVersion: "v5",
    contentRef: "drive:1abc",
    ...overrides,
  };
}

function template(assets: BootstrapTemplateAsset[]): BootstrapTemplateSource {
  return { templateId: "akilta-standard-template", assets };
}

test("B1: a valid request resolves a plan copying every recognized asset kind, stamped supersedesLocalAuthority: false", () => {
  const assets = [
    asset({ kind: "AGENT_NAVIGATION" }),
    asset({ kind: "CURRENT_STATE" }),
    asset({ kind: "SYSTEM_MAP" }),
    asset({ kind: "VERSION_EVOLUTION_MAP" }),
    asset({ kind: "DEPENDENCY_MAP" }),
    asset({ kind: "EXECUTION_CONTRACT" }),
    asset({ kind: "TASK_TEMPLATE" }),
    asset({ kind: "EVIDENCE_MANIFEST" }),
    asset({ kind: "REVIEW_FINDING_SCHEMA" }),
    asset({ kind: "PROVIDER_CAPABILITY_REGISTRY_POINTER" }),
    asset({ kind: "PROTECTED_GATE_MAP" }),
  ];
  const plan = resolveProjectBootstrapPlan({
    targetProjectNamespace: "bestprintsco",
    existingProjectNamespaces: ["akilta"],
    template: template(assets),
  });
  assert.equal(plan.targetProjectNamespace, "bestprintsco");
  assert.equal(plan.templateId, "akilta-standard-template");
  assert.equal(plan.copiedAssets.length, assets.length);
  assert.equal(plan.rejectedAssets.length, 0);
  for (const copied of plan.copiedAssets) {
    assert.equal(copied.supersedesLocalAuthority, false);
  }
});

test("B2: targetProjectNamespace colliding with an existing project namespace fails closed (uniqueness enforced)", () => {
  assert.throws(
    () =>
      resolveProjectBootstrapPlan({
        targetProjectNamespace: "akilta",
        existingProjectNamespaces: ["akilta", "bestprintsco"],
        template: template([asset()]),
      }),
    InvalidProjectBootstrapRequestError,
  );
});

test("B3: an asset with an unrecognized kind (e.g. a fabricated credential/provider-secret kind) is rejected, not copied", () => {
  const credentialLikeAsset = asset({ kind: "PRODUCTION_CREDENTIAL" as BootstrapTemplateAsset["kind"] });
  const plan = resolveProjectBootstrapPlan({
    targetProjectNamespace: "bestprintsco",
    existingProjectNamespaces: ["akilta"],
    template: template([asset(), credentialLikeAsset]),
  });
  assert.equal(plan.copiedAssets.length, 1);
  assert.equal(plan.rejectedAssets.length, 1);
  assert.equal(plan.rejectedAssets[0]?.asset, credentialLikeAsset);
  assert.match(plan.rejectedAssets[0]?.reason ?? "", /not a recognized reusable structural asset kind/);
});

test("B4: two projects bootstrapped from the same template source produce independently isolated plans (no cross-project contamination)", () => {
  const sharedTemplate = template([asset({ contentRef: "drive:shared-1" })]);

  const planForProjectA = resolveProjectBootstrapPlan({
    targetProjectNamespace: "project-a",
    existingProjectNamespaces: ["akilta"],
    template: sharedTemplate,
  });
  const planForProjectB = resolveProjectBootstrapPlan({
    targetProjectNamespace: "project-b",
    existingProjectNamespaces: ["akilta", "project-a"],
    template: sharedTemplate,
  });

  assert.equal(planForProjectA.targetProjectNamespace, "project-a");
  assert.equal(planForProjectB.targetProjectNamespace, "project-b");
  assert.notEqual(planForProjectA.targetProjectNamespace, planForProjectB.targetProjectNamespace);
  // Each plan's copied assets are independent array instances - mutating
  // one plan's output cannot be observed through the other.
  assert.notEqual(planForProjectA.copiedAssets, planForProjectB.copiedAssets);
});

test("B5: contentRef is forwarded verbatim as an opaque pointer, never interpreted - even a string shaped like executable content passes through unchanged", () => {
  const dangerousLookingRef = "require('child_process').exec('rm -rf /')";
  const plan = resolveProjectBootstrapPlan({
    targetProjectNamespace: "bestprintsco",
    existingProjectNamespaces: ["akilta"],
    template: template([asset({ contentRef: dangerousLookingRef })]),
  });
  assert.equal(plan.copiedAssets[0]?.contentRef, dangerousLookingRef);
});

test("B6: source provenance (sourceProjectRef/sourceVersion) is preserved verbatim on every copied asset", () => {
  const plan = resolveProjectBootstrapPlan({
    targetProjectNamespace: "bestprintsco",
    existingProjectNamespaces: ["akilta"],
    template: template([asset({ sourceProjectRef: "akilta", sourceVersion: "v5-rev42" })]),
  });
  assert.equal(plan.copiedAssets[0]?.sourceProjectRef, "akilta");
  assert.equal(plan.copiedAssets[0]?.sourceVersion, "v5-rev42");
});

test("B7: an empty/whitespace-only targetProjectNamespace fails closed", () => {
  assert.throws(
    () =>
      resolveProjectBootstrapPlan({
        targetProjectNamespace: "   ",
        existingProjectNamespaces: [],
        template: template([asset()]),
      }),
    InvalidProjectBootstrapRequestError,
  );
});

test("B8: a template with zero assets resolves an empty plan rather than throwing", () => {
  const plan = resolveProjectBootstrapPlan({
    targetProjectNamespace: "bestprintsco",
    existingProjectNamespaces: ["akilta"],
    template: template([]),
  });
  assert.equal(plan.copiedAssets.length, 0);
  assert.equal(plan.rejectedAssets.length, 0);
});
