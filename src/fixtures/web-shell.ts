import { WEBSITE_BUILD_V1_OWNERSHIP } from "./website-build-v1-communication.js";
import { WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT } from "./website-build-v1-snapshot.js";
import { WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION } from "./website-build-v1-team-attention.js";
import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { ClientProjectSnapshot } from "../domain/client-project-snapshot.js";
import type { TeamAttentionProjection } from "../domain/team-attention-projection.js";
import { createAuthenticatedPrincipal, createSessionContext, type SessionContext } from "../web/session-context.js";
import type { ClientProjectSnapshotSource } from "../web/snapshot-view-state.js";
import type { TeamAttentionSource } from "../web/team-attention-view-state.js";

/**
 * V2-APP-001: one deterministic dev-fixture session, scoped to exactly
 * the existing `WEBSITE_BUILD_v1` ownership tuple (V2-CDO-003/005) -
 * reused rather than inventing a parallel identity.
 */
export const WEB_SHELL_DEV_SESSION_TOKEN = "dev-token-website-build-v1";

export const WEB_SHELL_DEV_SESSION: SessionContext = createSessionContext({
  principal: createAuthenticatedPrincipal({
    principalId: "principal-website-build-v1-owner",
    tenantId: WEBSITE_BUILD_V1_OWNERSHIP.tenantId,
    customerId: WEBSITE_BUILD_V1_OWNERSHIP.customerId,
    displayName: "Reference Customer Co",
  }),
  projectId: WEBSITE_BUILD_V1_OWNERSHIP.projectId,
  issuedAt: "2026-08-26T00:00:00Z",
});

export const WEB_SHELL_DEV_SESSION_FIXTURES: ReadonlyMap<string, SessionContext> = new Map([
  [WEB_SHELL_DEV_SESSION_TOKEN, WEB_SHELL_DEV_SESSION],
]);

function ownershipEquals(a: ProjectOwnershipRef, b: ProjectOwnershipRef): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.customerId === b.customerId &&
    a.projectId === b.projectId &&
    a.serviceRef === b.serviceRef
  );
}

/**
 * V2-APP-001 (IN SCOPE G): a minimal, deterministic, in-memory
 * `ClientProjectSnapshotSource` backed by the existing verified
 * `WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT` (V2-CDO-005) - a fixture,
 * never a durable production data source (Architecture Invariant #4).
 */
export function createWebShellFixtureSnapshotSource(): ClientProjectSnapshotSource {
  const snapshots: ReadonlyArray<ClientProjectSnapshot> = [WEBSITE_BUILD_V1_CLIENT_PROJECT_SNAPSHOT];
  return {
    getSnapshot(ownership: ProjectOwnershipRef): ClientProjectSnapshot | undefined {
      return snapshots.find((snapshot) => ownershipEquals(snapshot.ownership, ownership));
    },
  };
}

/**
 * V3 Full Blueprint §9 (Workstream F floor slice): a minimal,
 * deterministic, in-memory `TeamAttentionSource` backed by the existing
 * `WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION` fixture - a fixture, never
 * a durable production data source, matching
 * `createWebShellFixtureSnapshotSource`'s own pattern exactly.
 */
export function createWebShellFixtureTeamAttentionSource(): TeamAttentionSource {
  const projections: ReadonlyArray<TeamAttentionProjection> = [WEBSITE_BUILD_V1_TEAM_ATTENTION_PROJECTION];
  return {
    getTeamAttentionProjection(ownership: ProjectOwnershipRef): TeamAttentionProjection | undefined {
      return projections.find((projection) => ownershipEquals(projection, ownership));
    },
  };
}
