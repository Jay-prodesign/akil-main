import { resolve as resolvePath } from "node:path";
import type { Server } from "node:http";
import { createHttpServer } from "../web/http-server.js";
import { resolveAppConfig, type AppConfig } from "./app-config.js";
import { evaluateHealth, type HealthCheckResult, type HealthProbeResult } from "./health-check.js";
import { WEB_SHELL_DEV_SESSION_FIXTURES } from "../fixtures/web-shell.js";
import {
  createFileDurableRuntimeStores,
  probeFileDurableRuntimeStoreReadability,
  type FileDurableRuntimeStores,
} from "./file-durable-runtime-stores.js";
import { createDurableClientProjectSnapshotSource } from "../web/client-project-snapshot-durable-source.js";
import { createDurableWorkProjectSource } from "../web/work-project-admin-source.js";
import { createDurableWorkJobSource } from "../web/work-job-admin-source.js";
import { createDurableOperationalObservabilitySource } from "../web/operational-observability-admin-source.js";
import { createDurableConnectionsSource } from "../web/connections-durable-source.js";
import { createDurableKnowledgeSource } from "../web/knowledge-durable-source.js";
import { createDurablePeopleDirectorySource } from "../web/people-directory-durable-source.js";
import { createDurableCustomerOffboardingAdminSource } from "../web/customer-offboarding-admin-source.js";
import { createDurableOrganizationResourceBindingSource } from "../web/organization-resource-binding-durable-source.js";
import { createDurableInternalOsOrganizationSource } from "../web/internal-os-organization-durable-source.js";
import {
  createCurrentStaffAccessGrantsInternalOsRequestHandler,
  createDurableInternalOsStaffAccessGrantSource,
  type InternalOsStaffAccessGrantSource,
} from "../web/internal-os-staff-access-grant-durable-source.js";
import { selectInternalOsStaffSessionProvider } from "../web/staff-session-provider-selection.js";
import type { SessionContext } from "../web/session-context.js";
import type { StaffSessionContext } from "../web/staff-session-context.js";
import type { StaffAccessGrant } from "../web/internal-os-access.js";

/**
 * RUNTIME-001 introduced this file as the one Node-hosting-target adapter
 * that turns a resolved `AppConfig` into an actually-listening server. At
 * that point it was a bootstrap runtime that served in-memory fixtures
 * (`createWebShellFixtureSnapshotSource`/`createWebShellFixtureTeamAttentionSource`),
 * because no persistence-backed source existed yet.
 *
 * C1 (runtime composition root, FILE driver): that is no longer true, and
 * this is now the deployable runtime's composition root.
 *
 * - **Stores.** Every `FileDurable*` store a served route reads is built
 *   exactly once, rooted at `config.dataDir`
 *   (`createFileDurableRuntimeStores`).
 * - **Sources.** Every real durable source adapter the repository already
 *   has is built from those stores, and no fixture data source is
 *   injected. That covers CLIENT-SNAPSHOT-DURABLE-001, PROJ-DURABLE-001,
 *   WORK-JOB-SOURCE-001, OBS-ADMIN-SOURCE-001, CUS-OFFBOARD-DURABLE-001
 *   and ORG-MEMBERSHIP-DURABLE-001 and its follow-ons.
 * - **Staff access grants (C2).** The `/os` surface's `StaffAccessGrant[]`
 *   is read per request from `FileDurableStaffAccessGrantStore` joined with
 *   `FileDurableOrganizationMembershipStore`, for the configured
 *   internal-OS tenant (`createDurableInternalOsStaffAccessGrantSource`).
 *   A membership with no explicitly written grant record has no grant.
 * - **Connections destination (C3).** `/os/connections` reads the same
 *   `FileDurableConnectorConnectionStore` (`createDurableConnectionsSource`),
 *   masked through CONN-001's `buildIntegrationsAdminView`. A store read
 *   failure renders the OS ERROR page, not an empty list.
 * - **People directory (C3).** `/os/people` lists the configured tenant's
 *   memberships from the same `FileDurableOrganizationMembershipStore`
 *   (`createDurablePeopleDirectorySource`), next to the viewer's own
 *   membership. Only principal reference, role and state are shown. The
 *   roster requires WRITE (the destination itself stays READ, unchanged
 *   for the self-section) - see `resolvePeopleView`. A store read failure
 *   renders the OS ERROR page, not an empty roster.
 * - **Knowledge destination (C3).** `/os/knowledge` lists the configured
 *   tenant's recorded evidence references from the same
 *   `FileDurableEvidenceReferenceStore` the resource-binding source already
 *   reads (`createDurableKnowledgeSource`). Only an allow-list of fields is
 *   shown (`sourceLocator` is left out) - see `resolveKnowledgeView`. The
 *   destination stays WRITE-gated, unchanged. A store read failure renders
 *   the OS ERROR page, not an empty list.
 * - **Routing.** One Node server dispatches `GET /health`, then `/os/*`
 *   (the staff surface), then everything else (the customer `/portal`
 *   surface) - see `createHttpServer`.
 * - **Health.** `/health` aggregates the existing `config` probe plus one
 *   critical store-readability probe per store.
 *
 * Disclosed, not fabricated. These have no production-shaped source in
 * this repository, so they stay unwired and render their existing honest
 * "Unavailable"/`NOT_ACTIVE` states:
 *
 * - `teamAttentionSource`, `commercialStatusSource`,
 *   `billingReferenceStatusSource` and `lifecycleReadinessSource` (gap
 *   scan C9).
 *
 * This wires real DATA sources, not real AUTHENTICATION. No identity
 * verifier and no staff-session-provider override is passed. In
 * production, both the customer `SessionProvider` and the
 * `StaffSessionProvider` therefore stay unconditionally fail-closed
 * (always unauthenticated), so no durable record is served to anyone in
 * production. The SITE-INTEGRATION-001 discipline is unchanged.
 *
 * `PERSISTENCE_DRIVER=POSTGRES` fails closed at construction. No async
 * store has been threaded through the synchronous call sites yet: that
 * is RUNTIME-001's own explicitly deferred architectural decision (gap
 * scan D2). Booting with a silent FILE fallback would misreport which
 * store is serving data.
 */
export class UnsupportedRuntimePersistenceDriverError extends Error {
  constructor(driver: string) {
    super(
      `PERSISTENCE_DRIVER=${driver} is not wired into the runtime composition root: no async/network-backed store is threaded through the synchronous source adapters yet (a separate, explicit architectural decision). Use PERSISTENCE_DRIVER=FILE.`,
    );
    this.name = "UnsupportedRuntimePersistenceDriverError";
  }
}

/**
 * DEPLOY-003/RUNTIME-001's health aggregation, reused verbatim. C1 adds
 * the store-readability probes when the runtime's stores are supplied.
 * Without `stores`, the result is exactly the pre-C1 single `config`
 * probe.
 */
export function health(config: AppConfig, stores?: FileDurableRuntimeStores): HealthCheckResult {
  const probes: HealthProbeResult[] = [
    { name: "config", healthy: true, critical: true, detail: `deploymentEnv=${config.deploymentEnv}` },
  ];
  if (stores !== undefined) {
    probes.push(...probeFileDurableRuntimeStoreReadability(stores.dataDir));
  }
  return evaluateHealth(probes);
}

/**
 * Optional, non-production, non-authentication inputs, so a caller (a
 * test) can supply staff evidence without editing the composition root.
 * Deliberately absent: any `identityVerifier`, any `SessionProvider`/`StaffSessionProvider`
 * override, and any data source override. Data always comes from the
 * durable stores.
 *
 * - `devSessionFixtures`/`devStaffSessionFixtures` are consulted only when
 *   `deploymentEnv !== "production"`. In production, the fail-closed
 *   providers are selected and these maps are never read (the same
 *   discipline as `createHttpServer`/`createInternalOsHttpServer`).
 * - `staffAccessGrants`, when supplied, replaces the durable grant source
 *   with this fixed list (C1's original test seam, kept unchanged). When
 *   omitted (the deployable default since C2), grants are read per request
 *   from the durable grant and membership stores. Either way it is
 *   evidence only. It cannot authenticate anyone, and in production the
 *   staff provider still authenticates no one.
 */
export interface NodeRuntimeOptions {
  readonly devSessionFixtures?: ReadonlyMap<string, SessionContext>;
  readonly devStaffSessionFixtures?: ReadonlyMap<string, StaffSessionContext>;
  readonly staffAccessGrants?: ReadonlyArray<StaffAccessGrant>;
}

export interface NodeRuntime {
  readonly server: Server;
  readonly health: () => HealthCheckResult;
  /** The absolute FILE-driver data root this runtime's stores are rooted at. */
  readonly dataDir: string;
}

export function createNodeRuntime(config: AppConfig, options: NodeRuntimeOptions = {}): NodeRuntime {
  if (config.persistenceDriver !== "FILE") {
    throw new UnsupportedRuntimePersistenceDriverError(config.persistenceDriver);
  }
  const isProduction = config.deploymentEnv === "production";
  const dataDir = resolvePath(config.dataDir);
  const stores = createFileDurableRuntimeStores(dataDir);

  // Customer /portal sources.
  const snapshotSource = createDurableClientProjectSnapshotSource(
    stores.projectStore,
    stores.outcomeJobStore,
    stores.auditLog,
  );

  // Staff /os sources. Without a configured internal-OS organization there
  // is no tenant to read grants for; the handler renders NOT_FOUND anyway.
  const fixedGrants = options.staffAccessGrants;
  const grantSource: InternalOsStaffAccessGrantSource =
    fixedGrants !== undefined
      ? { listCurrentGrants: () => fixedGrants }
      : config.internalOsOrganization !== undefined
        ? createDurableInternalOsStaffAccessGrantSource(
            stores.staffAccessGrantStore,
            stores.organizationMembershipStore,
            config.internalOsOrganization,
          )
        : { listCurrentGrants: () => [] };
  const internalOsHandler = createCurrentStaffAccessGrantsInternalOsRequestHandler({
    provider: selectInternalOsStaffSessionProvider({
      isProduction,
      ...(options.devStaffSessionFixtures !== undefined ? { devStaffFixtures: options.devStaffSessionFixtures } : {}),
    }),
    organizationSource:
      config.internalOsOrganization !== undefined
        ? createDurableInternalOsOrganizationSource(
            stores.controlledOrganizationProvisioningStore,
            config.internalOsOrganization,
          )
        : undefined,
    grantSource,
    projectSource: createDurableWorkProjectSource(stores.projectStore),
    jobSource: createDurableWorkJobSource(stores.outcomeJobStore),
    resourceBindingSource: createDurableOrganizationResourceBindingSource(
      stores.organizationResourceBindingStore,
      stores.organizationMembershipStore,
      stores.organizationServicePrincipalStore,
      stores.projectStore,
      stores.connectorConnectionStore,
      stores.configurationPolicyDecisionStore,
      stores.evidenceReferenceStore,
    ),
    operationalObservabilitySource: createDurableOperationalObservabilitySource(stores.connectorConnectionStore),
    customerOffboardingAdminSource: createDurableCustomerOffboardingAdminSource(stores.customerOffboardingRequestStore),
    connectionsSource: createDurableConnectionsSource(stores.connectorConnectionStore),
    peopleDirectorySource: createDurablePeopleDirectorySource(stores.organizationMembershipStore),
    knowledgeSource: createDurableKnowledgeSource(stores.evidenceReferenceStore),
  });

  const server = createHttpServer({
    isProduction,
    devSessionFixtures: options.devSessionFixtures ?? WEB_SHELL_DEV_SESSION_FIXTURES,
    snapshotSource,
    internalOsHandler,
    healthCheck: () => {
      const result = health(config, stores);
      return { healthy: result.status !== "UNHEALTHY", body: JSON.stringify(result) };
    },
  });
  return { server, health: () => health(config, stores), dataDir };
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const config = resolveAppConfig(process.env);
  const runtime = createNodeRuntime(config);
  runtime.server.listen(config.port, () => {
    console.log(`AKILTA runtime listening on port ${config.port} (${config.deploymentEnv}, FILE data root ${runtime.dataDir})`);
  });
}
