import type { TenantScope } from "../domain/tenant-scope.js";
import type { OutcomeJob } from "../domain/outcome-job.js";
import type { PersistJobResult } from "../domain/durable-outcome-job-store.js";

/**
 * A deliberately distinct, network-backed sibling of
 * `DurableOutcomeJobStore` (`src/domain/durable-outcome-job-store.ts`) -
 * NOT a drop-in replacement. That interface is synchronous by design
 * (in-process `node:fs` calls); a network-backed store cannot honestly
 * implement it without either lying about synchronicity or blocking the
 * event loop. Rather than force a false unification, this is its own
 * port with the same idempotency contract (`putIfAbsent` is the sole
 * write path, same `PersistJobResult` shape) expressed as `Promise`s.
 * Wiring an async store into the domain's existing synchronous call
 * sites is an explicit, disclosed, out-of-scope decision for a later
 * checkpoint - not fabricated here.
 */
export interface AsyncOutcomeJobStore {
  putIfAbsent(job: OutcomeJob): Promise<PersistJobResult>;
  get(tenantId: TenantScope["tenantId"], jobId: OutcomeJob["jobId"]): Promise<OutcomeJob | undefined>;
  list(
    tenantId: TenantScope["tenantId"],
    projectId: OutcomeJob["projectId"],
  ): Promise<ReadonlyArray<OutcomeJob>>;
}
