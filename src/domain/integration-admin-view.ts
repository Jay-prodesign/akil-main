import type { ConnectionBinding, ConnectionState } from "./connection-authority.js";
import type { ProjectOwnershipRef } from "./project-ownership.js";
import type { ConnectorAuthMode, ConnectorCatalog, ConnectorKind } from "./integration-connector-catalog.js";
import type { StoredConnectorConnection } from "./durable-connector-connection-store.js";

/**
 * CONN-001 slice 3: the admin read-model surface ("Settings -> Integrations
 * / AI & Providers with provider catalog, connection instances, status/
 * health, ownership and tenant/project binding"). Pure aggregation only -
 * exactly the same genuine boundary `internal-command-projection.ts`
 * (`V5-CMD-001`) already disclosed and did not fabricate a way around: this
 * repository has no internal/staff authentication concept anywhere
 * (`AuthenticatedPrincipal`/`SessionContext`/`TenantContext` are
 * exclusively customer/tenant-scoped, built for the customer-facing Client
 * Portal). Inventing an internal-principal/session concept here would be
 * the same genuine new architectural decision `V5-CMD-001` deferred, not
 * something a bounded read-model slice should decide unilaterally - so
 * this module has NO HTTP/session/route wiring, exactly like that one.
 *
 * Deliberately cross-tenant, matching `V5-CMD-001`'s own precedent: an
 * internal company-wide integrations view is exactly the case where
 * seeing across every tenant is the intended, authorized behavior for
 * internal staff, never for a customer session.
 *
 * SECRET-MASKING STRUCTURAL GUARANTEE: CONN-001's own acceptance floor
 * requires secrets to be "write-only/masked through a vault/secret-
 * management boundary." `IntegrationConnectionSummary` has no field
 * capable of holding a `SecretRef`/`secretRefId` at all - not merely
 * omitted by convention, but structurally absent from the type - so this
 * admin view can never leak a connection's secret reference, even to an
 * authorized administrator. Only `connection-authority.ts`'s own
 * evidence-gated `verificationEvidenceRef` (an audit pointer, never a
 * credential) passes through.
 */
export interface IntegrationConnectorCatalogEntry {
  readonly connectorKind: ConnectorKind;
  readonly displayName: string;
  readonly supportedAuthModes: ReadonlyArray<ConnectorAuthMode>;
  readonly isAiModelProvider: boolean;
  readonly requiresOAuthRedirect: boolean;
}

export interface IntegrationConnectionSummary {
  readonly connectionBindingId: ConnectionBinding["connectionBindingId"];
  readonly connectorKind: ConnectorKind;
  readonly authMode: ConnectorAuthMode;
  readonly connectionState: ConnectionState;
  readonly ownership: ProjectOwnershipRef;
  readonly workspaceRef: string;
  readonly integrationInstanceRef: string;
  readonly version: number;
  readonly verificationEvidenceRef?: string;
}

export interface IntegrationsAdminView {
  readonly availableConnectors: ReadonlyArray<IntegrationConnectorCatalogEntry>;
  readonly connections: ReadonlyArray<IntegrationConnectionSummary>;
}

/**
 * Adds no independent judgment: every field is read directly off the
 * already-governed `ConnectorDescriptor`/`ConnectorConnectionInstance`
 * records this module is given, or omitted entirely (`secretRef`) - never
 * computed, inferred, or narrated.
 */
export function buildIntegrationsAdminView(input: {
  catalog: ConnectorCatalog;
  connections: ReadonlyArray<StoredConnectorConnection>;
}): IntegrationsAdminView {
  const availableConnectors: IntegrationConnectorCatalogEntry[] = [...input.catalog.descriptors.values()].map(
    (descriptor) => ({
      connectorKind: descriptor.connectorKind,
      displayName: descriptor.displayName,
      supportedAuthModes: descriptor.supportedAuthModes,
      isAiModelProvider: descriptor.isAiModelProvider,
      requiresOAuthRedirect: descriptor.requiresOAuthRedirect,
    }),
  );

  const connections: IntegrationConnectionSummary[] = input.connections.map((stored) => {
    const binding = stored.instance.binding;
    const base = {
      connectionBindingId: binding.connectionBindingId,
      connectorKind: stored.instance.connectorKind,
      authMode: stored.instance.authMode,
      connectionState: binding.connectionState,
      ownership: binding.ownership,
      workspaceRef: binding.workspaceRef,
      integrationInstanceRef: binding.integrationInstanceRef,
      version: stored.version,
    };
    if (binding.verificationEvidenceRef === undefined) {
      return base;
    }
    return { ...base, verificationEvidenceRef: binding.verificationEvidenceRef };
  });

  return { availableConnectors, connections };
}
