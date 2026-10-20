import type { Project } from "../domain/project.js";
import type { DurableOutcomeJobStore } from "../domain/durable-outcome-job-store.js";
import type { WorkJobSource } from "./internal-os-view-state.js";

/**
 * WORK-JOB-SOURCE-001 (self-selected, REV215 continuous-completion
 * authority — the same "wire an existing optional admin/view port to a
 * real store" vein as `OBS-ADMIN-SOURCE-001`/`customer-offboarding-admin-
 * source.ts`/`work-project-admin-source.ts`, not one of the Founder-
 * authorization-only persistence candidates): `WorkJobSource`'s own doc
 * comment in `internal-os-view-state.ts` already notes "a real
 * `DurableOutcomeJobStore`/`AsyncOutcomeJobStore` (OS-V0-03) can satisfy
 * this structurally" - `PROJ-DURABLE-001` supplies the one missing
 * ingredient (a real `Project` to call `listJobs(project)` with), so this
 * closes the wiring with zero new persistence and zero new query shape:
 * `DurableOutcomeJobStore.list(tenantId, customerId, projectId)` already
 * matches `WorkJobSource.listJobs(project)`'s own shape exactly (`OutcomeJob`'s
 * `customerId`/`projectId` fields are typed identically to `Project`'s own,
 * per `outcome-job.ts`).
 *
 * No additional cross-tenant/cross-project re-verification is layered on
 * top of `list(tenantId, customerId, projectId)` here: `FileDurableOutcomeJobStore`'s
 * own `validatePersistedOutcomeJobLine` already fails closed on
 * cross-tenant contamination on every read, and `list` itself already
 * filters its result to the exact given `customerId`/`projectId` - a
 * second filter here would be dead, non-load-bearing code, mirroring this
 * corridor's own established discipline (see `operational-observability-
 * admin-source.ts`'s identical reasoning for not re-adding
 * `FileDurableConnectorConnectionStore`'s own already-proven guarantee).
 */
export function createDurableWorkJobSource(store: DurableOutcomeJobStore): WorkJobSource {
  return {
    listJobs(project: Project) {
      return store.list(project.tenantId, project.customerId, project.projectId);
    },
  };
}
