import { createTenantScope, type TenantScope } from "../domain/tenant-scope.js";
import { createCustomer, type Customer } from "../domain/customer.js";
import { createProject, type Project } from "../domain/project.js";
import { createOfferBlueprintVersion, type OfferBlueprintVersion } from "../domain/offer-blueprint.js";
import { createSoldScope, type SoldScope } from "../domain/sold-scope.js";
import { createCustomerEvidenceItem, type CustomerEvidenceItem } from "../domain/customer-evidence.js";

/**
 * DEL-003 "Reference Proof": exactly one bounded WEBSITE_BUILD_v1
 * blueprint/fixture, sufficient to exercise the compiler end-to-end
 * (discovery/evidence, content/IA, design/build, SEO/runtime QA, required
 * access/connection declarations, working-artifact checkpoint, approval
 * lineage, handover and verification), without implementing any of those
 * downstream systems. This is a test/reference artifact only - not a
 * customer commitment, production website, or public offer change.
 */
export const WEBSITE_BUILD_V1_BLUEPRINT: OfferBlueprintVersion = createOfferBlueprintVersion({
  blueprintId: "website-build-v1",
  version: "1.0.0",
  requirements: [
    {
      requirementId: "discovery-evidence-intake",
      description: "Capture and typed-classify discovery evidence (Fact/Hypothesis/Unknown) for the website build",
      necessity: "REQUIRED",
      dependsOn: [],
    },
    {
      requirementId: "content-information-architecture",
      description: "Define site content inventory and information architecture from discovery evidence",
      necessity: "REQUIRED",
      dependsOn: ["discovery-evidence-intake"],
    },
    {
      requirementId: "design-build",
      description: "Design and build the site against the approved information architecture",
      necessity: "REQUIRED",
      dependsOn: ["content-information-architecture"],
    },
    {
      requirementId: "seo-runtime-qa",
      description: "Run SEO and runtime/browser QA against the built site",
      necessity: "REQUIRED",
      dependsOn: ["design-build"],
    },
    {
      requirementId: "required-access-connections",
      description: "Declare required external access/connections as versioned ConnectionRequirement references (no raw credentials)",
      necessity: "REQUIRED",
      dependsOn: [],
    },
    {
      requirementId: "working-artifact-checkpoint",
      description: "Publish a working-artifact checkpoint of the built site for review",
      necessity: "REQUIRED",
      dependsOn: ["design-build"],
    },
    {
      requirementId: "approval-lineage-capture",
      description: "Capture a version-bound approval decision against the working-artifact checkpoint",
      necessity: "REQUIRED",
      dependsOn: ["working-artifact-checkpoint"],
    },
    {
      requirementId: "handover",
      description: "Hand over the approved, QA-passed site to the customer",
      necessity: "REQUIRED",
      dependsOn: ["approval-lineage-capture", "seo-runtime-qa"],
    },
    {
      requirementId: "verification",
      description: "Independently verify the handed-over deliverable against acceptance criteria",
      necessity: "REQUIRED",
      dependsOn: ["handover"],
    },
    {
      requirementId: "optional-ecommerce-integration",
      description: "Integrate a storefront/commerce capability into the site",
      necessity: "CONDITIONAL",
      dependsOn: ["required-access-connections"],
    },
    {
      requirementId: "optional-multilingual-content",
      description: "Produce and wire a second locale for the site's content",
      necessity: "CONDITIONAL",
      dependsOn: ["content-information-architecture"],
    },
  ],
});

export interface WebsiteBuildV1Fixture {
  readonly tenantScope: TenantScope;
  readonly customer: Customer;
  readonly project: Project;
  readonly blueprint: OfferBlueprintVersion;
  readonly soldScope: SoldScope;
  readonly evidence: ReadonlyArray<CustomerEvidenceItem>;
}

/**
 * A single, deterministic "fully resolved" sold scope for the reference
 * proof: multilingual content sold in, e-commerce sold out - so the
 * compiled plan is COMPLETE (no UNKNOWN nodes) and exercises both
 * CONDITIONAL branches. Callers that want to exercise UNKNOWN/partial
 * scope scenarios build their own SoldScope against the same blueprint
 * instead of mutating this one.
 */
export function buildWebsiteBuildV1Fixture(): WebsiteBuildV1Fixture {
  const tenantScope = createTenantScope("tenant-website-build-v1");
  const customer = createCustomer({
    tenantScope,
    customerId: "cust-website-build-v1",
    displayName: "Reference Customer Co",
  });
  const project = createProject({
    tenantScope,
    customer,
    projectId: "proj-website-build-v1",
    ownerRef: "owner-website-build-v1",
    state: "active",
  });
  const soldScope = createSoldScope({
    tenantScope,
    project,
    soldScopeId: "sold-scope-website-build-v1",
    outcomeContractRef: "outcome-contract-website-build-v1",
    includedRequirementIds: ["optional-multilingual-content"],
    excludedRequirementIds: ["optional-ecommerce-integration"],
  });
  const evidence: CustomerEvidenceItem[] = [
    createCustomerEvidenceItem({
      tenantScope,
      project,
      evidenceRef: "ev-brand-guidelines",
      kind: "FACT",
      subject: "Customer supplied an existing brand guideline document",
      sourceLocator: "internal://reference-fixtures/website-build-v1/brand-guidelines",
      relatedRequirementId: "discovery-evidence-intake",
    }),
    createCustomerEvidenceItem({
      tenantScope,
      project,
      evidenceRef: "ev-second-locale-market",
      kind: "HYPOTHESIS",
      subject: "Customer may want the second locale to target a specific regional market",
      sourceLocator: "internal://reference-fixtures/website-build-v1/second-locale-note",
      relatedRequirementId: "optional-multilingual-content",
    }),
  ];

  return { tenantScope, customer, project, blueprint: WEBSITE_BUILD_V1_BLUEPRINT, soldScope, evidence };
}
