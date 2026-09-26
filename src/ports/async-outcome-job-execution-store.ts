import type { TenantScope } from "../domain/tenant-scope.js";
import type { Customer } from "../domain/customer.js";
import type { Project } from "../domain/project.js";
import type { OutcomeJob } from "../domain/outcome-job.js";
import type { OutcomeJobExecutionEvent } from "../domain/outcome-job-execution-event.js";
import type { OutcomeJobExecutionRunState } from "../domain/outcome-job-execution-run-state.js";

/**
 * A deliberately distinct, network-backed sibling of
 * `DurableOutcomeJobExecutionStore` (`src/domain/durable-outcome-job-execution-store.ts`)
 * - NOT a drop-in replacement, for the same reason `AsyncOutcomeJobStore`
 * is not a drop-in for `DurableOutcomeJobStore`: that interface is
 * synchronous by design (in-process `node:fs` calls), and a network-backed
 * store cannot honestly implement it without lying about synchronicity or
 * blocking the event loop.
 */
export interface AsyncOutcomeJobExecutionStore {
  /**
   * Rev145 F1: resolves `true` only when THIS call durably created the
   * event (an atomic database-constraint claim), `false` when it already
   * existed - see `PostgresOutcomeJobExecutionStore.appendEvent`.
   */
  appendEvent(event: OutcomeJobExecutionEvent): Promise<boolean>;
  getEvents(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): Promise<ReadonlyArray<OutcomeJobExecutionEvent>>;
  getState(
    tenantId: TenantScope["tenantId"],
    customerId: Customer["customerId"],
    projectId: Project["projectId"],
    jobId: OutcomeJob["jobId"],
    runId: string,
  ): Promise<OutcomeJobExecutionRunState | undefined>;
}
