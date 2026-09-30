import type {
  QuotaEnvelope,
  QuotaReservationIdentity,
  QuotaAdmissionOutcome,
  QuotaCommitOutcome,
  QuotaReleaseOutcome,
  QuotaReadModel,
} from "../domain/execution-quota-admission.js";

/**
 * A deliberately distinct, network-backed sibling of
 * `FileDurableQuotaReservationStore` (`src/domain/durable-quota-reservation-store.ts`)
 * - NOT a drop-in replacement, for the same reason `AsyncOutcomeJobExecutionStore`
 * is not a drop-in for `DurableOutcomeJobExecutionStore`: the file store is
 * synchronous by design (in-process `node:fs` calls, whose synchronicity IS
 * its own single-process atomicity proof), and a network-backed store cannot
 * honestly implement that without lying about synchronicity or blocking the
 * event loop.
 */
export interface AsyncQuotaReservationStore {
  admit(input: {
    readonly envelope: QuotaEnvelope;
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly requestedAmount: { presence: unknown; amountMinorUnits?: unknown; currency?: unknown };
    readonly occurredAt: unknown;
  }): Promise<QuotaAdmissionOutcome>;
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
  }): Promise<QuotaCommitOutcome>;
  release(input: {
    readonly identity: QuotaReservationIdentity;
    readonly idempotencyKey: unknown;
    readonly occurredAt: unknown;
    readonly reason?: unknown;
  }): Promise<QuotaReleaseOutcome>;
  getReadModel(envelope: QuotaEnvelope): Promise<QuotaReadModel>;
}
