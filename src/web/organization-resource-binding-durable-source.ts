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
 * Per the Brain's own explicit instruction, this adapter never manufactures
 * `READY` by inventing current evidence for a dimension that has no durable
 * "current" registry anywhere in this repository: `currentEffectiveConfigRefs`,
 * `currentEffectivePolicyRefs`, `currentWorkerRouteDecisions`, and
 * `currentKnowledgeEvidenceRefs` are each passed as real, honest empty
 * evidence (not a fabricated "all current" claim). `resolveOrganizationResourceBindingStatus`'s
 * own gates already handle this correctly without any special-casing here:
 * a binding that never referenced one of these dimensions (`*Refs` is
 * `[]`) skips that gate entirely and can still reach `READY`; a binding
 * that DID reference one (bootstrap-time provenance only, per
 * `organization-resource-binding.ts`'s own Rev183 F2 doc comment)
 * truthfully blocks on that gate forever via this adapter, since no
 * current evidence can ever be supplied for it yet - exactly the Brain's
 * own "let the existing resolver return its truthful BLOCKED/ACTION_REQUIRED
 * state" instruction, not a defect to work around.
 */
export function createDurableOrganizationResourceBindingSource(
  bindingStore: DurableOrganizationResourceBindingStore,
  membershipStore: DurableOrganizationMembershipStore,
  servicePrincipalStore: DurableOrganizationServicePrincipalStore,
  projectStore: DurableProjectStore,
  connectorConnectionStore: DurableConnectorConnectionStore,
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

      return resolveOrganizationResourceBindingStatus({
        binding,
        organization,
        currentMemberships,
        currentServicePrincipals,
        currentConnections,
        currentProject,
        currentEffectiveConfigRefs: [],
        currentEffectivePolicyRefs: [],
        currentWorkerRouteDecisions: [],
        currentKnowledgeEvidenceRefs: [],
      });
    },
  };
}
