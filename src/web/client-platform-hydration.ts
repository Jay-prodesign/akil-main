import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import type { SessionProvider } from "./session-provider.js";
import { requireSession, UnauthenticatedError } from "./route-guard.js";
import { resolveProtectedSnapshotView, type ClientProjectSnapshotSource } from "./snapshot-view-state.js";
import { resolveShellCopy } from "./shell-copy.js";
import type { Locale } from "./locale.js";

/**
 * SITE-INTEGRATION-001: the exact closed state set the live commerce-site
 * client-platform-v1 shell contract declares (`window.AKILTAClientPlatform`).
 * `loading` and `unavailable` are the site theme's own
 * pre-hydration states - nothing on this side of the contract ever emits
 * them, so they intentionally never appear in this module's return type.
 */
export type ClientPlatformState =
  | "signed-out"
  | "ready"
  | "empty"
  | "unauthorized"
  | "error"
  | "unsupported";

export interface ClientPlatformIdentity {
  readonly name?: string;
  readonly sessionLabel?: string;
}

export interface ClientPlatformProject {
  readonly title?: string;
  readonly status?: string;
  readonly summary?: string;
  readonly nextAction?: string;
}

/**
 * Mirrors the live theme's documented hydrate payload shape exactly.
 * `projects` is deliberately absent from this type, not merely optional -
 * this repository has no trusted account-level project-list projection
 * (SITE-INTEGRATION-001's own non-scope), so there is no code path in this
 * module capable of constructing one, rather than merely a convention of
 * omitting it at the call site.
 */
export interface ClientPlatformHydratePayload {
  readonly state: ClientPlatformState;
  readonly identity?: ClientPlatformIdentity;
  readonly project?: ClientPlatformProject;
  readonly error?: { readonly message?: string };
}

const READY_STATUS_SET: ReadonlySet<string> = new Set(["IN_PROGRESS", "BLOCKED", "COMPLETE"]);

/**
 * Resolves the customer-safe hydrate payload for one protected portal
 * route. This function reuses `requireSession` and
 * `resolveProtectedSnapshotView` verbatim - the exact same auth/ownership/
 * snapshot gate order the existing HTML portal route already uses - rather
 * than re-implementing authorization for a second, parallel route. Nothing
 * in this function's own logic can grant access `resolveProtectedSnapshotView`
 * itself did not already grant; this function only ever narrows what an
 * already-authorized `ClientProjectSnapshot` exposes, never widens it.
 *
 * NOT_FOUND (a snapshot source returning nothing, or a source-returned
 * snapshot whose ownership does not match the request) has no dedicated
 * literal in the live theme's state enum. Per this repository's existing
 * DEC-153 "no invented business rule" discipline (already applied to
 * `outcome-job.ts`'s exception-state graph and this snapshot's own
 * `EtaProjection`/`EXTERNAL_WAIT` handling), this is mapped to the same
 * `empty` state as `NOT_STARTED` rather than fabricating a new state or
 * overclaiming `error` for what is not a runtime failure - both cases mean
 * "no active delivery status to show for this authorized scope."
 */
export function resolveClientPlatformHydration(input: {
  sessionToken: string | undefined;
  requestedOwnership: ProjectOwnershipRef;
  sessionProvider: SessionProvider;
  snapshotSource: ClientProjectSnapshotSource;
  locale: Locale;
}): ClientPlatformHydratePayload {
  let session;
  try {
    session = requireSession(input.sessionProvider, input.sessionToken);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return { state: "signed-out" };
    }
    throw error;
  }

  const view = resolveProtectedSnapshotView({
    session,
    requestedOwnership: input.requestedOwnership,
    source: input.snapshotSource,
  });

  const copy = resolveShellCopy(input.locale);

  switch (view.kind) {
    case "FORBIDDEN_TENANT_SCOPE":
      return { state: "unauthorized" };
    case "NOT_FOUND":
      return { state: "empty" };
    case "ERROR":
      // Deliberately no `error.message`: `view.reason` originates from
      // whatever the snapshot source itself threw and may carry internal
      // detail (adversarial proof #6 - no internal-only field may reach
      // this customer-safe payload). There is no existing customer-safe
      // error-message catalog to sanitize it against, so the field is
      // omitted entirely rather than passed through unsanitized.
      return { state: "error" };
    case "READY": {
      const overallStatus = view.snapshot.deliveryStatus.overallStatus;
      if (!READY_STATUS_SET.has(overallStatus)) {
        return { state: "empty" };
      }
      return {
        state: "ready",
        identity: { name: session.principal.displayName },
        project: {
          status: copy.deliveryStatusLabel[overallStatus],
          nextAction: copy.nextAction[view.snapshot.nextAction.owner].label,
        },
      };
    }
  }
}
