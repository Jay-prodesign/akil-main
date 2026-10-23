import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import { type ClientProjectSnapshot, buildClientProjectSnapshot } from "../domain/client-project-snapshot.js";
import type { DurableProjectStore } from "../domain/durable-project-store.js";
import type { DurableOutcomeJobStore } from "../domain/durable-outcome-job-store.js";
import type { AuditLog } from "../ports/audit-log.js";
import type { ClientProjectSnapshotSource } from "./snapshot-view-state.js";

/**
 * CLIENT-SNAPSHOT-DURABLE-001 (Brain-requested fresh-scan on PR #145
 * `6193989189`, "fresh-scan the remaining Project-store-unblocked
 * consumers" after `WORK-JOB-SOURCE-001`): `node-server-entrypoint.ts`'s
 * own doc comment has stated since `V2-APP-001` that "wiring a real,
 * persistence-backed `ClientProjectSnapshotSource`... is an explicit,
 * disclosed, later decision - not fabricated here, since no such source
 * exists yet," and every caller (`createWebShellFixtureSnapshotSource`)
 * has only ever been a single-record in-memory fixture. `PROJ-DURABLE-001`
 * and `WORK-JOB-SOURCE-001` together supply exactly the two ingredients
 * `buildClientProjectSnapshot`'s own REQUIRED inputs need - `project:
 * Project` and `jobs: ReadonlyArray<OutcomeJob>` - no third new store is
 * needed.
 *
 * Deliberately minimal: only the two required inputs are supplied.
 * `buildClientProjectSnapshot`'s own OPTIONAL inputs
 * (`plan`/`latestApproval`/`communicationHistory`/`capabilityAdmissions`/
 * `auditEvents`) are left absent, exactly as that function's own contract
 * already allows - no `ProjectPlanVersion`/`ApprovalReference`/
 * `ProjectCommunicationHistory`/`CapabilityAdmission`/`AuditEvent` lookup
 * capability is invented here. This is not fabrication: `workingArtifact`
 * stays absent, `capabilities`/`recentCommunications` stay empty, `eta`
 * stays `{ status: "UNKNOWN" }`, and `nextAction` stays
 * `NO_ACTION_NEEDED` - the exact same honest defaults
 * `buildClientProjectSnapshot`'s own doc comment already specifies for an
 * absent optional input, not a value this adapter invents.
 *
 * The `ownership` the caller supplies (including its own `serviceRef`, a
 * dimension `Project` itself has no field for) is passed straight into
 * `buildClientProjectSnapshot` unmodified and is never used to filter the
 * project lookup itself - the lookup is by `tenantId`/`customerId`/
 * `projectId` only, exactly the three fields `Project` actually has.
 * `resolveProtectedSnapshotView` (`snapshot-view-state.ts`) already
 * independently re-verifies the returned snapshot's own `ownership`
 * (service dimension included) against the caller's requested ownership
 * before ever reaching `READY`, so this adapter does not need to
 * duplicate that check.
 *
 * Brain CHANGES_REQUIRED (PR #160, exact head `3754cda7a092017309f23df8a0d63a655538786b`,
 * F1): the original version of this adapter caught EVERY exception from
 * `projectStore.get`/`jobStore.list` - including a genuine storage/data-
 * integrity failure (a corrupted tenant file) - and collapsed it into
 * `undefined`, which `resolveProtectedSnapshotView` treats as the honest
 * "no such project" `NOT_FOUND` outcome. That conflated two genuinely
 * different conditions: "this project does not exist" versus "the store
 * could not be read." `resolveProtectedSnapshotView` (`snapshot-view-
 * state.ts`) ALREADY catches exceptions thrown by `source.getSnapshot`
 * and maps them to the explicit `{ kind: "ERROR", reason }` state - this
 * adapter's own earlier doc comment incorrectly claimed otherwise. The
 * correct behavior is therefore to NOT catch here at all: `undefined` is
 * returned only for the genuine "project absent" case (`projectStore.get`
 * returning `undefined`), and any real read/replay-corruption exception
 * propagates uncaught to `resolveProtectedSnapshotView`'s own existing,
 * correct `ERROR` handling - never silently relabeled as `NOT_FOUND`.
 *
 * AUDIT-DURABLE-001 (Brain continuation, PR #145 comment `6205619559`):
 * `auditLog.findByTenant` is tenant-scoped only (the `AuditLog` port's own
 * existing contract, preserved exactly, not widened with a new project-
 * scoped query method); this adapter filters the tenant-wide result down
 * to the exact current project's own `customerId`/`projectId` before
 * passing it to `buildClientProjectSnapshot` - `buildDeliveryTimeline`
 * itself would otherwise fail closed on any foreign-project event, so
 * this filter is required, not optional, for the golden path to ever
 * reach `READY`.
 *
 * C1 update: `node-server-entrypoint.ts` no longer injects
 * `createWebShellFixtureSnapshotSource`. Its composition root now wires
 * this adapter, over the runtime's one `FileDurableProjectStore`/
 * `FileDurableOutcomeJobStore`/`FileDurableAuditLog`, into the live
 * `/portal` route. The "no such source exists yet" comment quoted above
 * has been replaced there.
 */
export function createDurableClientProjectSnapshotSource(
  projectStore: DurableProjectStore,
  jobStore: DurableOutcomeJobStore,
  auditLog: AuditLog,
): ClientProjectSnapshotSource {
  return {
    getSnapshot(ownership: ProjectOwnershipRef): ClientProjectSnapshot | undefined {
      const stored = projectStore.get(ownership.tenantId, ownership.customerId, ownership.projectId);
      if (stored === undefined) {
        return undefined;
      }
      const project = stored.project;
      const jobs = jobStore.list(project.tenantId, project.customerId, project.projectId);
      const auditEvents = auditLog
        .findByTenant({ tenantId: project.tenantId })
        .filter((event) => event.customerId === project.customerId && event.projectId === project.projectId);
      return buildClientProjectSnapshot({ ownership, project, jobs, auditEvents });
    },
  };
}
