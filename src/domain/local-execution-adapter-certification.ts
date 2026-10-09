import type {
  DeviceRegistration,
  LocalWorkerRegistration,
  LocalTaskLeaseStatus,
  LocalWorkerAdapterResult,
} from "./local-execution.js";
import type { BridgeConnectionState } from "./local-execution-bridge.js";

export class InvalidLocalExecutionAdapterCertificationError extends Error {
  constructor(reason: string) {
    super(`Invalid Local Execution adapter certification operation: ${reason}`);
    this.name = "InvalidLocalExecutionAdapterCertificationError";
  }
}

/**
 * OS-V1-06 (Provider/Worker Adapter Certification). AA-005 REV209: "for
 * each activated adapter record start/resume/cancel/events/usage/evidence/
 * sandbox/network/tool-boundary/checkpoint/recovery/failure semantics...
 * Witness false success, event loss/duplication, cancel race, restart,
 * timeout, partial effect -> UNKNOWN and stale authority."
 *
 * Reuse-first: start/resume (`createClaudeRunRequest`/`createCodexRunRequest`),
 * cancel (`TASK_CANCELLED` -> `BLOCKED`, the `CANCEL` bridge message kind,
 * and `LocalTaskLeaseStatus`'s own closed transition graph), events
 * (`ClaudeRunEventKind`/`CodexRunEventKind` -> `BridgeProtocolMessageKind`),
 * usage (`ClaudeUsageLimitStatus`/`CodexUsageLimitStatus`), evidence
 * (`evidenceRef` mandatory on every terminal result), sandbox/network
 * (`CodexSandboxMode`/`CodexNetworkPolicy`), tool-boundary
 * (`allowedToolRefs`/`isWorkspaceRootAllowed`), checkpoint/recovery
 * (`LocalTaskCheckpoint`/`CHECKPOINTED` <-> `RUNNING`), and "unsupported
 * means UNSUPPORTED/BLOCKED, never simulated success"
 * (`DeviceCapabilityReadiness` already names both; `resolveClaudeRunReadiness`/
 * `resolveCodexRunReadiness`/`resolveClaudeAdapterCapabilityReadiness` already
 * fail closed on policy/auth) are ALL already closed by LOCAL-EXEC-001/002/003/006
 * - cited, not re-proven, in `docs/exec-plans/active/OS-V1-06.md`.
 *
 * This module closes the two genuinely untested seams a repository-wide
 * inspection found: (1) a terminal adapter result is never re-checked
 * against the device/worker's own CURRENT standing before being admitted
 * as this task's true outcome ("stale authority"), and (2) there was no
 * honest disposition for a run whose real-world effect became unknowable
 * mid-flight - a lost connection or an exceeded deadline with no terminal
 * event observed ("partial effect -> UNKNOWN", "timeout").
 */

/**
 * "Stale authority": a `LocalWorkerAdapterResult` is produced by whatever
 * device/worker standing was current AT DISPATCH time, but by the time it
 * is actually admitted, that standing may have changed (the device was
 * revoked/quarantined, or the worker's trust was revoked) - exactly the
 * same "re-resolve fresh immediately before granting" gap this corridor has
 * already closed at every other admission point (`requireInternalOsAccess`,
 * `resolveEffectiveDelegatedAccess`, `restoreOrganizationLifecycleFromSnapshot`).
 * A caller must supply the CURRENT `DeviceRegistration`/`LocalWorkerRegistration`
 * (re-read immediately before calling this, never a snapshot taken at
 * dispatch time) - this function never re-derives currentness itself (it
 * has no store dependency, mirroring every other pure domain module in
 * this family). Fails closed on a device that is no longer `ONLINE` or a
 * worker that is no longer `ADMITTED`, regardless of what the result
 * itself claims - a result is never admitted on its own say-so.
 */
export function admitLocalWorkerAdapterResult(input: {
  result: LocalWorkerAdapterResult;
  currentDevice: DeviceRegistration;
  currentWorker: LocalWorkerRegistration;
}): LocalWorkerAdapterResult {
  if (input.currentWorker.deviceId !== input.currentDevice.deviceId) {
    throw new InvalidLocalExecutionAdapterCertificationError(
      "currentWorker.deviceId does not match the given currentDevice's own deviceId",
    );
  }
  if (input.currentDevice.status !== "ONLINE") {
    throw new InvalidLocalExecutionAdapterCertificationError(
      `cannot admit an adapter result from a device that is no longer ONLINE (current status: ${input.currentDevice.status}) - ` +
        "a terminal result observed after the device was revoked/quarantined/offlined must never be accepted as this task's true outcome",
    );
  }
  if (input.currentWorker.trustStatus !== "ADMITTED") {
    throw new InvalidLocalExecutionAdapterCertificationError(
      `cannot admit an adapter result from a worker that is no longer ADMITTED (current trustStatus: ${input.currentWorker.trustStatus}) - ` +
        "stale authority at dispatch time must never be silently honored at admission time",
    );
  }
  return input.result;
}

const NON_TERMINAL_LEASE_STATUSES: ReadonlySet<LocalTaskLeaseStatus> = new Set([
  "QUEUED",
  "LEASED",
  "RUNNING",
  "CHECKPOINTED",
  "BLOCKED",
]);

export type AmbiguousLocalRunDisposition = "UNKNOWN" | "NOT_APPLICABLE";

export interface AmbiguousLocalRunResolution {
  readonly disposition: AmbiguousLocalRunDisposition;
  readonly allowedLeaseTarget?: "BLOCKED";
  readonly reason: string;
}

/**
 * "Partial effect -> UNKNOWN" and "timeout": a run can become unknowable
 * two ways - the device/bridge connection is lost before any terminal
 * event arrives, or a caller-tracked deadline elapses with no terminal
 * event, while the connection itself may still read `CONNECTED` (a hung
 * agent, not a dropped link). Either way the real-world effect of
 * whatever work was in flight cannot be determined - it may have
 * completed, partially completed, or never started - and must never be
 * reported as `SUCCEEDED` or `FAILED`. The only safe disposition is
 * `UNKNOWN`, and the only safe lease transition is to the existing,
 * unmodified `BLOCKED` status (already reachable from `RUNNING`/
 * `CHECKPOINTED` in `local-execution.ts`'s own `LEASE_TRANSITIONS` - this
 * module invents no new lease status), pending a fresh reconciling signal
 * once the device reconnects and reports its own true terminal state
 * ("recovery").
 *
 * Returns `NOT_APPLICABLE` - never a fabricated `UNKNOWN` - when: a
 * terminal event was already observed (a real result must never be
 * overridden by a later ambiguity, closing the "false success" adjacent
 * risk of discarding a genuine terminal outcome); the lease is already
 * terminal (`SUCCEEDED`/`FAILED`/`CANCELLED` - this directly closes "cancel
 * race": a lease a `CANCEL` message already terminalized can never be
 * re-opened into `UNKNOWN`/`BLOCKED` by a late-arriving disconnect/timeout
 * signal for the same run); or the connection is still `CONNECTED`/
 * `CONNECTING` and no deadline was exceeded (nothing is actually ambiguous
 * yet).
 */
export function resolveAmbiguousLocalRunDisposition(input: {
  leaseStatus: LocalTaskLeaseStatus;
  connectionState: BridgeConnectionState;
  terminalEventObserved: boolean;
  deadlineExceeded: boolean;
}): AmbiguousLocalRunResolution {
  if (!NON_TERMINAL_LEASE_STATUSES.has(input.leaseStatus)) {
    return {
      disposition: "NOT_APPLICABLE",
      reason: `lease is already terminal (${input.leaseStatus}) - an ambiguity signal arriving after a real terminal disposition can never reopen it`,
    };
  }
  if (input.terminalEventObserved) {
    return {
      disposition: "NOT_APPLICABLE",
      reason: "a terminal event was already observed for this run - a real outcome is never overridden by a later ambiguity",
    };
  }
  const connectionLost = input.connectionState === "DISCONNECTED" || input.connectionState === "RECONNECTING";
  if (!connectionLost && !input.deadlineExceeded) {
    return {
      disposition: "NOT_APPLICABLE",
      reason: `connection state is ${input.connectionState} and no deadline was exceeded - nothing is currently ambiguous`,
    };
  }
  const triggers = [
    ...(connectionLost ? [`connection state is ${input.connectionState}`] : []),
    ...(input.deadlineExceeded ? ["the tracked deadline was exceeded"] : []),
  ].join(" and ");
  return {
    disposition: "UNKNOWN",
    allowedLeaseTarget: "BLOCKED",
    reason:
      `${triggers} with no terminal event observed for this run - the real-world effect of whatever work was in flight cannot be determined ` +
      "(it may have completed, partially completed, or never started) and must never be reported as SUCCEEDED or FAILED; the only safe lease " +
      "transition is to BLOCKED, pending a fresh reconciling signal once the device reconnects and reports its own true terminal state",
  };
}
