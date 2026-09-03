import { createProjectOwnershipRef, type ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { SessionProvider } from "./session-provider.js";
import { requireSession, UnauthenticatedError } from "./route-guard.js";
import { resolveProtectedSnapshotView, type ClientProjectSnapshotSource } from "./snapshot-view-state.js";
import { resolveProtectedTeamAttentionView, type TeamAttentionSource } from "./team-attention-view-state.js";
import { renderShellPage, type ShellPageContent, type RenderedShellPage } from "./shell-render.js";

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
    if (request.method !== "GET") {
      return toResponse(
        renderShellPage({ kind: "UNSUPPORTED", reason: `method ${request.method} is not supported` }),
      );
    }

    const requestedOwnership = parsePortalPath(request.path);
    if (requestedOwnership === undefined) {
      return toResponse(renderShellPage({ kind: "NOT_FOUND" }));
    }

    let session;
    try {
      session = requireSession(deps.sessionProvider, request.headers[SESSION_TOKEN_HEADER]);
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        return toResponse(renderShellPage({ kind: "UNAUTHENTICATED" }));
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

    return toResponse(renderShellPage(content));
  };
}
