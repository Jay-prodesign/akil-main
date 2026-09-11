import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type { ExternalSaleBootstrapResult } from "./external-sale-bootstrap.js";

export class InvalidDurableExternalSaleBootstrapStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableExternalSaleBootstrapStore operation: ${reason}`);
    this.name = "InvalidDurableExternalSaleBootstrapStoreError";
  }
}

export interface PersistExternalSaleBootstrapResult {
  readonly result: ExternalSaleBootstrapResult;
  readonly created: boolean;
}

/**
 * Mirrors `durable-outcome-job-store.ts`'s own already-established
 * `putIfAbsent`-only idempotency pattern rather than inventing a new one:
 * this is the durable layer that lets `bootstrapExternalSaleOutcome`
 * (a pure, side-effect-free function) be safely replayed on duplicate
 * delivery or crash-recovery of the same `externalSaleRef` without ever
 * producing a second Project/SoldScope/OutcomeJob. `putIfAbsent` is the
 * sole write path - there is no plain "insert" - so replaying the same
 * externalSaleRef only ever reports `created: false` and hands back the
 * exact result first persisted.
 */
export interface DurableExternalSaleBootstrapStore {
  putIfAbsent(
    tenantId: TenantScope["tenantId"],
    externalSaleRef: string,
    result: ExternalSaleBootstrapResult,
  ): PersistExternalSaleBootstrapResult;
  get(
    tenantId: TenantScope["tenantId"],
    externalSaleRef: string,
  ): ExternalSaleBootstrapResult | undefined;
}

/**
 * Reference/local durable implementation using only Node's built-in
 * `node:fs` - no new runtime dependency, matching
 * `durable-outcome-job-store.ts`'s own boundary. One JSON-lines file per
 * tenant under `baseDir`, keyed by `externalSaleRef`; every read
 * reconstructs the current set from the full durable file in true append
 * order, keeping only the first record for any given `externalSaleRef` -
 * proving restart reconstruction converges to exactly one persisted
 * result per external sale, the same way `FileDurableOutcomeJobStore`
 * proves it for jobId.
 */
export class FileDurableExternalSaleBootstrapStore
  implements DurableExternalSaleBootstrapStore
{
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
  }

  private filePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.jsonl`);
  }

  private readAll(
    tenantId: TenantScope["tenantId"],
  ): Array<{ externalSaleRef: string; result: ExternalSaleBootstrapResult }> {
    const filePath = this.filePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            externalSaleRef: string;
            result: ExternalSaleBootstrapResult;
          },
      );
  }

  private dedupedByExternalSaleRef(
    records: ReadonlyArray<{
      externalSaleRef: string;
      result: ExternalSaleBootstrapResult;
    }>,
  ): Map<string, ExternalSaleBootstrapResult> {
    const byRef = new Map<string, ExternalSaleBootstrapResult>();
    for (const record of records) {
      if (!byRef.has(record.externalSaleRef)) {
        // First record for this externalSaleRef wins - a replayed
        // duplicate delivery or crash-recovery append is inert on
        // reconstruction.
        byRef.set(record.externalSaleRef, record.result);
      }
    }
    return byRef;
  }

  putIfAbsent(
    tenantId: TenantScope["tenantId"],
    externalSaleRef: string,
    result: ExternalSaleBootstrapResult,
  ): PersistExternalSaleBootstrapResult {
    if (externalSaleRef.trim().length === 0) {
      throw new InvalidDurableExternalSaleBootstrapStoreError(
        "externalSaleRef must be a non-empty string",
      );
    }
    const existing = this.get(tenantId, externalSaleRef);
    if (existing !== undefined) {
      if (
        existing.job.jobId !== result.job.jobId ||
        existing.project.projectId !== result.project.projectId ||
        existing.soldScope.soldScopeId !== result.soldScope.soldScopeId
      ) {
        throw new InvalidDurableExternalSaleBootstrapStoreError(
          `externalSaleRef "${externalSaleRef}" is already persisted with a different bootstrapped result`,
        );
      }
      return { result: existing, created: false };
    }
    const filePath = this.filePathFor(tenantId);
    const line = `${JSON.stringify({ externalSaleRef, result })}\n`;
    if (existsSync(filePath)) {
      const existingContent = readFileSync(filePath, "utf8");
      writeFileSync(filePath, existingContent + line, "utf8");
    } else {
      writeFileSync(filePath, line, "utf8");
    }
    return { result, created: true };
  }

  get(
    tenantId: TenantScope["tenantId"],
    externalSaleRef: string,
  ): ExternalSaleBootstrapResult | undefined {
    return this.dedupedByExternalSaleRef(this.readAll(tenantId)).get(
      externalSaleRef,
    );
  }
}
