import type { Organization } from "../domain/organization.js";
import {
  resolveOrganizationResourceBindingStatus,
  type OrganizationResourceBindingStatus,
} from "../domain/organization-resource-binding.js";
import type { DurableOrganizationResourceBindingStore } from "../domain/durable-organization-resource-binding-store.js";
import type { DurableOrganizationMembershipStore } from "../domain/durable-organization-membership-store.js";
import type { DurableOrganizationServicePrincipalStore } from "../domain/durable-organization-service-principal-store.js";
import type { DurableProjectStore } from "../domain/durable-project-store.js";
import type { DurableConnectorConnectionStore } from "../domain/durable-connector-connection-store.js";
import type { DurableConfigurationPolicyDecisionStore } from "../domain/durable-configuration-policy-decision-store.js";
import { encodeConfigurationPolicyDecisionKey } from "../domain/configuration-policy-decision-projection.js";
import type { DurableEvidenceReferenceStore } from "../domain/durable-evidence-reference-store.js";
import type { OrganizationResourceBindingSource } from "./internal-os-view-state.js";

/**
 * ORG-MEMBERSHIP-DURABLE-001 (Brain continuation, PR #145 comment
 * `6218736597`): `OrganizationResourceBindingSource`'s own doc comment
 * (`internal-os-view-state.ts`) has stated since Rev183 F3 that "no durable
 * `OrganizationResourceBinding` store is wired into production Admin/shell
 * composition yet." `OrganizationResourceBinding` itself
 * (`durable-organization-resource-binding-store.ts`), `Project`
 * (`PROJ-DURABLE-001`), and `ConnectorConnection`
 * (`durable-connector-connection-store.ts`) each already have a durable
 * store; this checkpoint's own new membership registry supplies the last
 * ingredient `resolveOrganizationResourceBindingStatus`'s `currentMemberships`
 * gate needs. This adapter composes all four into the smallest coherent
 * `OrganizationResourceBindingSource` - no new store, no new resolver logic.
 *
 * `resolveStatus` returns `undefined` (the Organization has genuinely never
 * been bootstrapped) only when no `OrganizationResourceBinding` exists for
 * it - exactly `OrganizationResourceBindingSource`'s own pre-existing
 * contract, never fabricated.
 *
 * ORG-SERVICE-PRINCIPAL-DURABLE-001 (Brain continuation, PR #145 comment
 * `6223155547`): `currentServicePrincipals` now has a real durable source
 * too (`durable-organization-service-principal-store.ts`), mirroring
 * `currentMemberships`'s own wiring exactly.
 *
 * ORG-CONFIG-POLICY-CURRENTNESS-001 (continuation after
 * `ORG-SERVICE-PRINCIPAL-DURABLE-001`'s own Brain independent review,
 * PR #164 comment `6237721816`): `currentEffectiveConfigRefs`/
 * `currentEffectivePolicyRefs` now have a real durable source too -
 * `resolveOrganizationResourceBindingStatus`'s own doc comment names it
 * exactly: "`resolveEffectiveConfigurationPolicy`'s own output shape - a
 * caller freshly resolves the current effective controls and passes the
 * resulting refs." The already-durable `DurableConfigurationPolicyDecisionStore`
 * (OS-V0-11 Phase A) IS that already-resolved, already-current decision -
 * this adapter reads its LATEST entry for this binding's own project scope
 * (`{ tenantId, customerId: binding.ownership.customerId, projectId:
 * binding.projectRef }`, the same identity `currentProject` is already
 * resolved against) rather than recomputing a resolution itself (this
 * adapter has no independent source of raw `controls` to recompute one
 * from, and must not invent one). No decision having ever been recorded
 * for that exact scope is itself an honest "nothing is currently
 * effective" answer (`[]`), not a fabricated claim - a binding that
 * bootstrap-time-referenced a config/policy ref before any decision exists
 * for its scope correctly blocks `ACTION_REQUIRED` until one is recorded.
 *
 * KNOWLEDGE-EVIDENCE-DURABLE-001 (REV216-CONTINUOUS-COMPLETION parent loop,
 * continuation after `ORG-CONFIG-POLICY-CURRENTNESS-001`): `currentKnowledge
 * EvidenceRefs` now has a real durable source too -
 * `durable-evidence-reference-store.ts`'s `DurableEvidenceReferenceStore`
 * supplies the "current" `EvidenceReference` registry
 * `resolveOrganizationResourceBindingStatus`'s own doc comment names
 * (`evidence.ts`'s `EvidenceReference` - "plain evidence-id presence").
 * This adapter lists every evidence reference currently recorded for this
 * binding's own tenant (the same tenant-scoped-list convention
 * `currentServicePrincipals`/`currentConnections` already use - the domain
 * gate itself only checks flat `evidenceId` membership, not a further
 * customer/project scope) and supplies their `evidenceId`s. This adapter
 * does not itself call `createEvidenceReference` or record anything -
 * recording evidence remains whatever other, already-authorized caller's
 * own responsibility it already was; it only reads what has already been
 * durably recorded.
 *
 * Per the Brain's own explicit instruction, this adapter still never
 * manufactures `READY` by inventing current evidence for a dimension that
 * has no durable "current" registry anywhere in this repository:
 * `currentWorkerRouteDecisions` remains real, honest empty evidence (not a
 * fabricated "all current" claim) - `resolveWorkerRoute`
 * (`worker-routing-policy.ts`) has no durable "admitted worker candidates
 * per route" registry to re-invoke against yet.
 * `resolveOrganizationResourceBindingStatus`'s own gates already handle
 * this correctly without any special-casing here: a binding that never
 * referenced a worker route (`workerRouteRefs` is `[]`) skips that gate
 * entirely and can still reach `READY`; a binding that DID reference one
 * (bootstrap-time provenance only, per `organization-resource-binding.ts`'s
 * own Rev183 F2 doc comment) truthfully blocks on that gate forever via
 * this adapter, since no current evidence can ever be supplied for it yet.
 */
export function createDurableOrganizationResourceBindingSource(
  bindingStore: DurableOrganizationResourceBindingStore,
  membershipStore: DurableOrganizationMembershipStore,
  servicePrincipalStore: DurableOrganizationServicePrincipalStore,
  projectStore: DurableProjectStore,
  connectorConnectionStore: DurableConnectorConnectionStore,
  configurationPolicyDecisionStore: DurableConfigurationPolicyDecisionStore,
  evidenceReferenceStore: DurableEvidenceReferenceStore,
): OrganizationResourceBindingSource {
  return {
    resolveStatus(organization: Organization): OrganizationResourceBindingStatus | undefined {
      const binding = bindingStore.get(organization.tenantId, organization.organizationId);
      if (binding === undefined) {
        return undefined;
      }

      const currentMemberships = membershipStore
        .listByTenant(organization.tenantId)
        .map((stored) => stored.membership);

      const currentServicePrincipals = servicePrincipalStore
        .listByTenant(organization.tenantId)
        .map((stored) => stored.servicePrincipal);

      const currentConnections = connectorConnectionStore
        .list(organization.tenantId)
        .map((stored) => stored.instance.binding);

      const currentProject = projectStore.get(
        organization.tenantId,
        binding.ownership.customerId,
        binding.projectRef,
      )?.project;

      const configPolicyDecisionKey = encodeConfigurationPolicyDecisionKey({
        tenantId: organization.tenantId,
        customerId: binding.ownership.customerId,
        projectId: binding.projectRef,
      });
      const activeConfigPolicyDecision = configurationPolicyDecisionStore.getActiveDecisionProjection(
        organization.tenantId,
        configPolicyDecisionKey,
      );

      const currentKnowledgeEvidenceRefs = evidenceReferenceStore
        .listByTenant(organization.tenantId)
        .map((stored) => stored.evidence.evidenceId);

      return resolveOrganizationResourceBindingStatus({
        binding,
        organization,
        currentMemberships,
        currentServicePrincipals,
        currentConnections,
        currentProject,
        currentEffectiveConfigRefs: activeConfigPolicyDecision?.resolution.effectiveConfigRefs ?? [],
        currentEffectivePolicyRefs: activeConfigPolicyDecision?.resolution.effectivePolicyRefs ?? [],
        currentWorkerRouteDecisions: [],
        currentKnowledgeEvidenceRefs,
      });
    },
  };
}
