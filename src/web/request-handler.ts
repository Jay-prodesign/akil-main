import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { SessionProvider } from "./session-provider.js";
import { requireSession, UnauthenticatedError } from "./route-guard.js";
import { resolveProtectedSnapshotView, type ClientProjectSnapshotSource } from "./snapshot-view-state.js";
import { resolveProtectedTeamAttentionView, type TeamAttentionSource } from "./team-attention-view-state.js";
import { renderShellPage, type ShellPageContent, type RenderedShellPage } from "./shell-render.js";
import { resolveRequestLocale } from "./locale.js";
import { resolveClientPlatformHydration, type ClientPlatformState } from "./client-platform-hydration.js";

const SESSION_TOKEN_HEADER = "x-akilta-session-token";

/**
 * V2-APP-001: transport-agnostic request/response shapes (ADR 0001) -
 * this whole module never imports `node:http`. `createHttpServer.ts` is
 * the only file that translates a real socket request/response into
 * these plain values, so every branch below is unit-testable without
 * opening a port.
 */
export interface IncomingRequestLike {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface OutgoingResponseLike {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type RequestHandler = (request: IncomingRequestLike) => OutgoingResponseLike;

function toResponse(rendered: RenderedShellPage): OutgoingResponseLike {
  return {
    status: rendered.status,
    headers: { "content-type": rendered.contentType },
    body: rendered.html,
  };
}

function parsePortalPath(path: string): ProjectOwnershipRef | undefined {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== "portal") {
    return undefined;
  }
  const [, tenantId, customerId, projectId] = segments;
  try {
    return createProjectOwnershipRef({ tenantId, customerId, projectId });
  } catch {
    return undefined;
  }
}

/**
 * SITE-INTEGRATION-001 Slice B: the JSON hydration path variant the live
 * commerce-site client-platform-v1 shell composes against. A distinct top-level
 * segment (`client-platform`, not `portal`) so this can never be confused
 * with - or silently fall through into - the existing HTML portal route.
 */
function parseClientPlatformPath(path: string): ProjectOwnershipRef | undefined {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== "client-platform") {
    return undefined;
  }
  const [, tenantId, customerId, projectId] = segments;
  try {
    return createProjectOwnershipRef({ tenantId, customerId, projectId });
  } catch {
    return undefined;
  }
}

function toJsonResponse(status: number, body: unknown): OutgoingResponseLike {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Mirrors the HTTP status this shell already uses for the equivalent HTML
 * `ShellPageContent` kind (see `shell-render.ts`), so the JSON hydration
 * route's status codes stay meaningful rather than always 200.
 */
const HYDRATION_STATUS_BY_STATE: Record<ClientPlatformState, number> = {
  "signed-out": 401,
  unauthorized: 403,
  empty: 200,
  error: 500,
  ready: 200,
  unsupported: 501,
};

/**
 * V2-APP-001 A10: `resolveProtectedSnapshotView` (and therefore
 * `snapshotSource.getSnapshot`) is only ever called AFTER `requireSession`
 * has already succeeded - an unauthenticated request never reaches the
 * snapshot source at all, not even to be rejected by it.
 *
 * V2-APP-001 A9: `NOT_STARTED`/`BLOCKED` overall delivery status is
 * mapped to the dedicated `EMPTY`/`BLOCKED` shell render primitives
 * rather than always rendering the generic `READY` body - still driven
 * entirely by the `ClientProjectSnapshot` the caller already validated,
 * never by reaching around it.
 */
export function createRequestHandler(deps: {
  sessionProvider: SessionProvider;
  snapshotSource: ClientProjectSnapshotSource;
  teamAttentionSource?: TeamAttentionSource;
}): RequestHandler {
  return (request: IncomingRequestLike): OutgoingResponseLike => {
    const locale = resolveRequestLocale(request.headers);

    const clientPlatformOwnership = parseClientPlatformPath(request.path);
    if (clientPlatformOwnership !== undefined) {
      if (request.method !== "GET") {
        return toJsonResponse(HYDRATION_STATUS_BY_STATE.unsupported, { state: "unsupported" });
      }
      const payload = resolveClientPlatformHydration({
        sessionToken: request.headers[SESSION_TOKEN_HEADER],
        requestedOwnership: clientPlatformOwnership,
        sessionProvider: deps.sessionProvider,
        snapshotSource: deps.snapshotSource,
        locale,
      });
      return toJsonResponse(HYDRATION_STATUS_BY_STATE[payload.state], payload);
    }

    if (request.method !== "GET") {
      return toResponse(
        renderShellPage({ kind: "UNSUPPORTED", reason: `method ${request.method} is not supported` }, locale),
      );
    }

    const requestedOwnership = parsePortalPath(request.path);
    if (requestedOwnership === undefined) {
      return toResponse(renderShellPage({ kind: "NOT_FOUND" }, locale));
    }

    let session;
    try {
      session = requireSession(deps.sessionProvider, request.headers[SESSION_TOKEN_HEADER]);
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        return toResponse(renderShellPage({ kind: "UNAUTHENTICATED" }, locale));
      }
      throw error;
    }

    const view = resolveProtectedSnapshotView({
      session,
      requestedOwnership,
      source: deps.snapshotSource,
    });

    let content: ShellPageContent;
    switch (view.kind) {
      case "FORBIDDEN_TENANT_SCOPE":
        content = { kind: "FORBIDDEN_TENANT_SCOPE" };
        break;
      case "NOT_FOUND":
        content = { kind: "NOT_FOUND" };
        break;
      case "ERROR":
        content = { kind: "ERROR", reason: view.reason };
        break;
      case "READY": {
        if (view.snapshot.deliveryStatus.overallStatus === "NOT_STARTED") {
          content = { kind: "EMPTY" };
          break;
        }
        const teamAttentionView = resolveProtectedTeamAttentionView({
          session,
          requestedOwnership,
          source: deps.teamAttentionSource,
        });
        if (view.snapshot.deliveryStatus.overallStatus === "BLOCKED") {
          content = { kind: "BLOCKED", snapshot: view.snapshot, teamAttention: teamAttentionView };
        } else {
          content = { kind: "READY", snapshot: view.snapshot, teamAttention: teamAttentionView };
        }
        break;
      }
    }

    return toResponse(renderShellPage(content, locale));
  };
}
