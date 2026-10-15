import type { ProjectOwnershipRef } from "../domain/project-ownership.js";
import { type ClientProjectSnapshot, buildClientProjectSnapshot } from "../domain/client-project-snapshot.js";
import type { DurableProjectStore } from "../domain/durable-project-store.js";
import type { DurableOutcomeJobStore } from "../domain/durable-outcome-job-store.js";
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
 * A store read failure (e.g. a corrupted tenant file) must never crash
 * the entire customer-facing `/portal` render - `resolveProtectedSnapshotView`
 * does not itself catch exceptions from a wired source, so `getSnapshot`
 * catches internally and degrades to `undefined` (the same honest
 * `NOT_FOUND` outcome already used when no snapshot exists at all),
 * mirroring `operational-observability-admin-source.ts`'s own established
 * "a throwing source degrades to the safe default rather than
 * propagating" precedent.
 */
export function createDurableClientProjectSnapshotSource(
  projectStore: DurableProjectStore,
  jobStore: DurableOutcomeJobStore,
): ClientProjectSnapshotSource {
  return {
    getSnapshot(ownership: ProjectOwnershipRef): ClientProjectSnapshot | undefined {
      try {
        const stored = projectStore.get(ownership.tenantId, ownership.customerId, ownership.projectId);
        if (stored === undefined) {
          return undefined;
        }
        const project = stored.project;
        const jobs = jobStore.list(project.tenantId, project.customerId, project.projectId);
        return buildClientProjectSnapshot({ ownership, project, jobs });
      } catch {
        return undefined;
      }
    },
  };
}
