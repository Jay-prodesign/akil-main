import type { Organization } from "../domain/organization.js";
import type { DurableProjectStore } from "../domain/durable-project-store.js";
import type { WorkProjectSource } from "./internal-os-view-state.js";

/**
 * PROJ-DURABLE-001 (Founder authorization, 2026-10-15): `WorkProjectSource`'s
 * own doc comment has stated since Rev168 that "no `ProjectStore`/
 * `ProjectPort` exists anywhere in this repository today," so `resolveWorkView`/
 * `resolveWorkProjectDetailView`/`resolveHomeView` have only ever rendered
 * `NOT_ACTIVE` for the "Work" destination - this is the smallest existing
 * blocked consumer the new `DurableProjectStore` genuinely unlocks: its own
 * `get(tenantId, customerId, projectId)` signature already matches
 * `WorkProjectSource.getProject`'s shape exactly, so this adapter is a thin,
 * direct pass-through - no new product scope, no new query shape invented.
 *
 * Deliberately NOT wired into `internal-os-dev-main.ts` here, mirroring
 * `customer-offboarding-admin-source.ts`/`operational-observability-admin-source.ts`'s
 * own established precedent: the one real dev-fixture caller in this
 * repository has never wired any of the optional admin/work-surface
 * sources; this checkpoint does not change that pattern on its own
 * initiative. A caller that separately wires this adapter into a running
 * route is a later, explicit integration decision.
 *
 * C1 update: that integration step is now done. The deployable runtime's
 * composition root (`node-server-entrypoint.ts`) wires this adapter, over
 * the runtime's one `FileDurableProjectStore`, into the live `/os` route.
 * `internal-os-dev-main.ts` still uses its in-memory review fixtures.
 */
export function createDurableWorkProjectSource(store: DurableProjectStore): WorkProjectSource {
  return {
    getProject(input: {
      tenantId: Organization["tenantId"];
      customerId: string;
      projectId: string;
    }) {
      const stored = store.get(
        input.tenantId,
        input.customerId as Parameters<DurableProjectStore["get"]>[1],
        input.projectId as Parameters<DurableProjectStore["get"]>[2],
      );
      return stored?.project;
    },
  };
}
