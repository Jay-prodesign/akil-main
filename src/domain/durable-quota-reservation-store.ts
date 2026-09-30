import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  admitQuotaReservation,
  commitQuotaUsage,
  releaseQuotaReservation,
  projectQuotaReadModel,
  validatePersistedQuotaReservationEvent,
  findCanonicalLatestForIdempotencyKey,
  quotaScopeKey,
  EMPTY_QUOTA_LEDGER,
  InvalidQuotaAdmissionError,
  type QuotaAdmissionScope,
  type QuotaEnvelope,
  type QuotaReservationIdentity,
  type QuotaLedger,
  type QuotaReservationEvent,
  type QuotaAdmissionOutcome,
  type QuotaCommitOutcome,
  type QuotaReleaseOutcome,
  type QuotaReadModel,
} from "./execution-quota-admission.js";

export class CorruptedQuotaReservationRecordError extends Error {
  constructor(reason: string) {
    super(`Corrupted persisted quota reservation record: ${reason}`);
    this.name = "CorruptedQuotaReservationRecordError";
  }
}

/**
 * Reference/local durable implementation, mirroring
 * `FileDurableOutcomeJobExecutionStore`/`FileDurableConnectorConnectionStore`
 * exactly: one append-only JSON-lines file per budget scope under `baseDir`,
 * `node:fs` only, no new runtime dependency.
 *
 * Real single-process atomicity (Minimum Adversarial Evidence #1: "two
 * concurrent reservations competing for the last allowance -> at most one
 * wins") comes from `admit`/`commit`/`release` being fully SYNCHRONOUS
 * methods with no `await` anywhere in their read-decide-write critical
 * section - exactly the same discipline `FileDurableConnectorConnectionStore
 * .save()` and `FileDurableOutcomeJobExecutionStore.appendEvent()` already
 * rely on: two "concurrent" async callers issued via `Promise.all` cannot
 * actually interleave inside a synchronous function in JavaScript's
 * single-threaded, run-to-completion execution model, so the first caller's
 * full read-decide-write always completes before the second caller's own
 * synchronous call begins.
 */
export class FileDurableQuotaReservationStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathFor(scope: QuotaAdmissionScope): string {
    const safeKey = Buffer.from(quotaScopeKey(scope), "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private readLedger(scope: QuotaAdmissionScope): QuotaLedger {
    const filePath = this.filePathFor(scope);
    if (!existsSync(filePath)) {
      return EMPTY_QUOTA_LEDGER;
    }
    const content = readFileSync(filePath, "utf8");
    const events: QuotaReservationEvent[] = content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (cause) {
          throw new CorruptedQuotaReservationRecordError(`line is not valid JSON (${(cause as Error).message})`);
        }
        try {
          return validatePersistedQuotaReservationEvent(parsed, scope);
        } catch (cause) {
          throw new CorruptedQuotaReservationRecordError((cause as Error).message);
        }
      });
    return { events };
  }

  private writeLedger(scope: QuotaAdmissionScope, ledger: QuotaLedger): void {
    const filePath = this.filePathFor(scope);
    const content = ledger.events.map((event) => JSON.stringify(event)).join("\n");
    writeFileSync(filePath, ledger.events.length > 0 ? `${content}\n` : "", "utf8");
  }

  admit(input: {
    readonly envelope: QuotaEnvelope;
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly requestedAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
    readonly occurredAt: unknown;
  }): QuotaAdmissionOutcome {
    const ledger = this.readLedger(input.envelope.scope);
    const { ledger: nextLedger, outcome } = admitQuotaReservation({ ledger, ...input });
    this.writeLedger(input.envelope.scope, nextLedger);
    return outcome;
  }

  commit(input: {
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly actualAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
    readonly occurredAt: unknown;
    readonly attribution?: {
      workerRef?: unknown;
      providerRef?: unknown;
      modelRef?: unknown;
      routeRef?: unknown;
    };
    readonly allowedOverage?: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
  }): QuotaCommitOutcome {
    const ledger = this.readLedger(input.identity.scope);
    const { ledger: nextLedger, outcome } = commitQuotaUsage({ ledger, ...input });
    this.writeLedger(input.identity.scope, nextLedger);
    return outcome;
  }

  release(input: {
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly occurredAt: unknown;
    readonly reason?: unknown;
  }): QuotaReleaseOutcome {
    const ledger = this.readLedger(input.identity.scope);
    const { ledger: nextLedger, outcome } = releaseQuotaReservation({ ledger, ...input });
    this.writeLedger(input.identity.scope, nextLedger);
    return outcome;
  }

  getReadModel(envelope: QuotaEnvelope): QuotaReadModel {
    return projectQuotaReadModel(this.readLedger(envelope.scope), envelope);
  }

  /**
   * Rev179 F14: a pure, non-mutating read - never appends, never fabricates
   * a commit that did not really happen.
   */
  peekSettlement(input: {
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
  }): { readonly settled: true; readonly event: QuotaReservationEvent } | { readonly settled: false } {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0) {
      throw new InvalidQuotaAdmissionError("idempotencyKey must be a non-empty string");
    }
    const ledger = this.readLedger(input.identity.scope);
    const latest = findCanonicalLatestForIdempotencyKey(ledger, input.identity.scope.tenantId, input.idempotencyKey);
    if (latest !== undefined && (latest.type === "COMMITTED" || latest.type === "RECONCILIATION_REQUIRED")) {
      return { settled: true, event: latest };
    }
    return { settled: false };
  }
}
