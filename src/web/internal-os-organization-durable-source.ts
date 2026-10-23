import type { Organization } from "../domain/organization.js";
import { createTenantScope, type TenantScope } from "../domain/tenant-scope.js";
import type { FileDurableControlledOrganizationProvisioningStore } from "../domain/durable-controlled-organization-provisioning-store.js";
import {
  createInternalOsRequestHandler,
  type InternalOsRequestHandler,
  type InternalOsRequestHandlerDeps,
} from "./internal-os-request-handler.js";
import { renderInternalOsPage, type RenderedInternalOsPage } from "./internal-os-render.js";
import type { OutgoingResponseLike } from "./request-handler.js";

/**
 * C1 (runtime composition root): `createInternalOsRequestHandler` takes one
 * fixed `organization` value at construction time. Until now its only
 * callers (`internal-os-dev-main.ts`, tests) passed an in-memory fixture
 * (`REVIEW_ORGANIZATION`). A deployable runtime cannot fix the
 * Organization at boot. Its lifecycle state is durable, current truth
 * owned by OS-V1-01's provisioning ledger (`suspend`/`reactivate`/
 * `reinitialize`), and a value captured at boot would keep rendering a
 * SUSPENDED organization as ACTIVE until the next restart.
 *
 * This port therefore returns the CURRENT `Organization` each time it is
 * called. `undefined` means "this organization has never been
 * provisioned" (not "the store could not be read" - a read or replay
 * failure throws, mirroring CLIENT-SNAPSHOT-DURABLE-001's Brain F1
 * correction: a real storage error is never relabeled as absence).
 */
export interface InternalOsOrganizationSource {
  getCurrentOrganization(): Organization | undefined;
}

/**
 * Reads the configured organization's own ledger fresh on every call
 * (`FileDurableControlledOrganizationProvisioningStore.getCurrentState`
 * replays that ledger from disk every time - there is no cache to go
 * stale). `tenantId` is validated through `createTenantScope` here, at
 * construction, so a malformed configured tenant fails at boot rather than
 * on the first request.
 */
export function createDurableInternalOsOrganizationSource(
  store: FileDurableControlledOrganizationProvisioningStore,
  ref: { readonly tenantId: string; readonly organizationId: string },
): InternalOsOrganizationSource {
  const tenantScope: TenantScope = createTenantScope(ref.tenantId);
  const organizationId = ref.organizationId;
  return {
    getCurrentOrganization(): Organization | undefined {
      return store.getCurrentState(tenantScope, organizationId)?.organization;
    },
  };
}

function toResponse(rendered: RenderedInternalOsPage): OutgoingResponseLike {
  return {
    status: rendered.status,
    headers: { "content-type": rendered.contentType },
    body: rendered.html,
  };
}

/**
 * Composes the existing, unmodified `createInternalOsRequestHandler` with
 * a per-request Organization lookup. All of that handler's own logic
 * (method check, path parsing, `requireInternalOsAccess`, nav gating,
 * destination resolution) runs unchanged. The only thing added is
 * resolving `organization` first, on every request:
 *
 * - `organizationSource` absent (the deployment configured no internal-OS
 *   organization) renders `NOT_FOUND` - this deployment has no staff
 *   surface to show.
 * - the source returns `undefined` (never provisioned) renders `NOT_FOUND`.
 * - the source throws (e.g. a corrupted provisioning ledger) renders the
 *   existing `ERROR` page (500, no detail rendered) - never `NOT_FOUND`,
 *   and never a crash of the whole process.
 *
 * Neither failure path renders any organization or session data.
 */
export function createCurrentOrganizationInternalOsRequestHandler(
  deps: Omit<InternalOsRequestHandlerDeps, "organization"> & {
    readonly organizationSource: InternalOsOrganizationSource | undefined;
  },
): InternalOsRequestHandler {
  const { organizationSource, ...handlerDeps } = deps;
  return (request) => {
    if (organizationSource === undefined) {
      return toResponse(renderInternalOsPage({ kind: "NOT_FOUND" }));
    }
    let organization: Organization | undefined;
    try {
      organization = organizationSource.getCurrentOrganization();
    } catch {
      return toResponse(
        renderInternalOsPage({ kind: "ERROR", reason: "internal OS organization state could not be read" }),
      );
    }
    if (organization === undefined) {
      return toResponse(renderInternalOsPage({ kind: "NOT_FOUND" }));
    }
    return createInternalOsRequestHandler({ ...handlerDeps, organization })(request);
  };
}
