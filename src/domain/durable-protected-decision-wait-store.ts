import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TenantScope } from "./tenant-scope.js";
import type {
  ProtectedDecisionWaitRequest,
  ProtectedDecisionResumeAuthorization,
} from "./protected-decision-wait-gate.js";

export class InvalidDurableProtectedDecisionWaitStoreError extends Error {
  constructor(reason: string) {
    super(`Invalid DurableProtectedDecisionWaitStore operation: ${reason}`);
    this.name = "InvalidDurableProtectedDecisionWaitStoreError";
  }
}

export class CorruptedProtectedDecisionWaitLineError extends Error {
  constructor(filePath: string, reason: string) {
    super(`Corrupted durable protected-decision-wait line (${filePath}): ${reason}`);
    this.name = "CorruptedProtectedDecisionWaitLineError";
  }
}

export interface PersistResult<T> {
  readonly value: T;
  readonly created: boolean;
}

function fail(filePath: string, reason: string): never {
  throw new CorruptedProtectedDecisionWaitLineError(filePath, reason);
}

function requireNonEmptyStringField(value: unknown, field: string, filePath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(filePath, `${field} must be a non-empty string`);
  }
  return value as string;
}

function requirePositiveIntegerField(value: unknown, field: string, filePath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(filePath, `${field} must be a positive integer`);
  }
  return value as number;
}

/**
 * Rev94-pattern discipline reused verbatim: persisted state is an
 * external/untrusted boundary on replay.
 */
function validatePersistedWaitRequest(
  raw: unknown,
  expectedTenantId: TenantScope["tenantId"],
  filePath: string,
): { waitRequestId: string; request: ProtectedDecisionWaitRequest } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, "line must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;
  const waitRequestId = requireNonEmptyStringField(record["waitRequestId"], "waitRequestId", filePath);
  const rawRequest = record["request"];
  if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
    fail(filePath, `record "${waitRequestId}".request must be a JSON object`);
  }
  const requestObj = rawRequest as Record<string, unknown>;
  const tenantId = requireNonEmptyStringField(requestObj["tenantId"], `record "${waitRequestId}".request.tenantId`, filePath);
  if (tenantId !== expectedTenantId) {
    fail(
      filePath,
      `record "${waitRequestId}" is stored under tenant file "${expectedTenantId}" but request.tenantId is "${tenantId}" - cross-tenant contamination`,
    );
  }
  const requestWaitRequestId = requireNonEmptyStringField(
    requestObj["waitRequestId"],
    `record "${waitRequestId}".request.waitRequestId`,
    filePath,
  );
  if (requestWaitRequestId !== waitRequestId) {
    fail(filePath, `record "${waitRequestId}".request.waitRequestId does not match the record's own key`);
  }
  const customerId = requireNonEmptyStringField(requestObj["customerId"], `record "${waitRequestId}".request.customerId`, filePath);
  const projectId = requireNonEmptyStringField(requestObj["projectId"], `record "${waitRequestId}".request.projectId`, filePath);
  const jobId = requireNonEmptyStringField(requestObj["jobId"], `record "${waitRequestId}".request.jobId`, filePath);
  const runId = requireNonEmptyStringField(requestObj["runId"], `record "${waitRequestId}".request.runId`, filePath);
  const attempt = requirePositiveIntegerField(requestObj["attempt"], `record "${waitRequestId}".request.attempt`, filePath);
  const effectRef = requireNonEmptyStringField(requestObj["effectRef"], `record "${waitRequestId}".request.effectRef`, filePath);
  const decisionRef = requireNonEmptyStringField(requestObj["decisionRef"], `record "${waitRequestId}".request.decisionRef`, filePath);
  const reason = requireNonEmptyStringField(requestObj["reason"], `record "${waitRequestId}".request.reason`, filePath);
  const activationFingerprintAtWait = requireNonEmptyStringField(
    requestObj["activationFingerprintAtWait"],
    `record "${waitRequestId}".request.activationFingerprintAtWait`,
    filePath,
  );
  const raisedAt = requireNonEmptyStringField(requestObj["raisedAt"], `record "${waitRequestId}".request.raisedAt`, filePath);

  const request: ProtectedDecisionWaitRequest = {
    waitRequestId: requestWaitRequestId as unknown as ProtectedDecisionWaitRequest["waitRequestId"],
    tenantId: tenantId as TenantScope["tenantId"],
    customerId: customerId as unknown as ProtectedDecisionWaitRequest["customerId"],
    projectId: projectId as unknown as ProtectedDecisionWaitRequest["projectId"],
    jobId: jobId as unknown as ProtectedDecisionWaitRequest["jobId"],
    runId,
    attempt,
    effectRef,
    decisionRef,
    reason,
    activationFingerprintAtWait,
    raisedAt,
  };
  return { waitRequestId, request };
}

function waitRequestCoreIdentityEquals(a: ProtectedDecisionWaitRequest, b: ProtectedDecisionWaitRequest): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validatePersistedResumeAuthorization(
  raw: unknown,
  expectedWaitRequestId: string,
  filePath: string,
): { waitRequestId: string; authorization: ProtectedDecisionResumeAuthorization } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(filePath, "line must be a JSON object, not an array or primitive");
  }
  const record = raw as Record<string, unknown>;
  const waitRequestId = requireNonEmptyStringField(record["waitRequestId"], "waitRequestId", filePath);
  if (waitRequestId !== expectedWaitRequestId) {
    fail(filePath, `record waitRequestId "${waitRequestId}" does not match the expected "${expectedWaitRequestId}"`);
  }
  const rawAuthorization = record["authorization"];
  if (typeof rawAuthorization !== "object" || rawAuthorization === null || Array.isArray(rawAuthorization)) {
    fail(filePath, `record "${waitRequestId}".authorization must be a JSON object`);
  }
  const authObj = rawAuthorization as Record<string, unknown>;
  const effectRef = requireNonEmptyStringField(authObj["effectRef"], `record "${waitRequestId}".authorization.effectRef`, filePath);
  const resolvedAt = requireNonEmptyStringField(authObj["resolvedAt"], `record "${waitRequestId}".authorization.resolvedAt`, filePath);
  const resolvedByPrincipalRef = requireNonEmptyStringField(
    authObj["resolvedByPrincipalRef"],
    `record "${waitRequestId}".authorization.resolvedByPrincipalRef`,
    filePath,
  );
  const decisionRef = requireNonEmptyStringField(
    authObj["decisionRef"],
    `record "${waitRequestId}".authorization.decisionRef`,
    filePath,
  );
  const decisionEvidenceRef = requireNonEmptyStringField(
    authObj["decisionEvidenceRef"],
    `record "${waitRequestId}".authorization.decisionEvidenceRef`,
    filePath,
  );
  const authorization: ProtectedDecisionResumeAuthorization = {
    waitRequestId: waitRequestId as unknown as ProtectedDecisionResumeAuthorization["waitRequestId"],
    effectRef,
    resolvedAt,
    resolvedByPrincipalRef,
    decisionRef,
    decisionEvidenceRef,
  };
  return { waitRequestId, authorization };
}

/**
 * OS-V0-10 benchmark-audit amendment: "single-use/idempotent resume." Two
 * independent `putIfAbsent`-only durable logs, directly cloning
 * `FileDurableOrganizationResourceBindingStore`'s already-accepted
 * `linkSync`-based atomic-creation/content-revalidation-on-replay pattern:
 * one for the WAIT request itself (`putIfAbsentWaitRequest`/`get`), one for
 * its eventual resume claim (`claimResume`/`getResume`). A caller's SECOND
 * `claimResume` call for an already-resumed `waitRequestId` is a safe,
 * idempotent no-op returning the SAME `ProtectedDecisionResumeAuthorization`
 * - exactly the "single-use" guarantee this gate requires - never a second
 * effect-authorizing claim.
 */
export interface DurableProtectedDecisionWaitStore {
  putIfAbsentWaitRequest(
    tenantId: TenantScope["tenantId"],
    waitRequestId: string,
    request: ProtectedDecisionWaitRequest,
  ): PersistResult<ProtectedDecisionWaitRequest>;
  get(tenantId: TenantScope["tenantId"], waitRequestId: string): ProtectedDecisionWaitRequest | undefined;
  claimResume(
    tenantId: TenantScope["tenantId"],
    waitRequestId: string,
    authorization: ProtectedDecisionResumeAuthorization,
  ): PersistResult<ProtectedDecisionResumeAuthorization>;
  getResume(tenantId: TenantScope["tenantId"], waitRequestId: string): ProtectedDecisionResumeAuthorization | undefined;
}

export class FileDurableProtectedDecisionWaitStore implements DurableProtectedDecisionWaitStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    mkdirSync(this.baseDir, { recursive: true });
    mkdirSync(this.waitCreationLockDir(), { recursive: true });
    mkdirSync(this.resumeCreationLockDir(), { recursive: true });
  }

  private waitFilePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.wait.jsonl`);
  }

  private resumeFilePathFor(tenantId: TenantScope["tenantId"]): string {
    const safeKey = Buffer.from(tenantId, "utf8").toString("base64url");
    return join(this.baseDir, `${safeKey}.resume.jsonl`);
  }

  private waitCreationLockDir(): string {
    return join(this.baseDir, ".wait-creation-locks");
  }

  private resumeCreationLockDir(): string {
    return join(this.baseDir, ".resume-creation-locks");
  }

  private waitCreationLockPathFor(tenantId: TenantScope["tenantId"], waitRequestId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const waitKey = Buffer.from(waitRequestId, "utf8").toString("base64url");
    return join(this.waitCreationLockDir(), `${tenantKey}.${waitKey}.lock`);
  }

  private resumeCreationLockPathFor(tenantId: TenantScope["tenantId"], waitRequestId: string): string {
    const tenantKey = Buffer.from(tenantId, "utf8").toString("base64url");
    const waitKey = Buffer.from(waitRequestId, "utf8").toString("base64url");
    return join(this.resumeCreationLockDir(), `${tenantKey}.${waitKey}.lock`);
  }

  private readAllWaitRequests(tenantId: TenantScope["tenantId"]): Array<{ waitRequestId: string; request: ProtectedDecisionWaitRequest }> {
    const filePath = this.waitFilePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new CorruptedProtectedDecisionWaitLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
      }
      return validatePersistedWaitRequest(parsed, tenantId, filePath);
    });
  }

  private readAllResumes(tenantId: TenantScope["tenantId"]): Array<{ waitRequestId: string; authorization: ProtectedDecisionResumeAuthorization }> {
    const filePath = this.resumeFilePathFor(tenantId);
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new CorruptedProtectedDecisionWaitLineError(filePath, `line is not valid JSON (${(cause as Error).message})`);
      }
      const record = parsed as Record<string, unknown>;
      const waitRequestId = typeof record["waitRequestId"] === "string" ? record["waitRequestId"] : "";
      return validatePersistedResumeAuthorization(parsed, waitRequestId, filePath);
    });
  }

  private dedupedWaitRequestsById(
    records: ReadonlyArray<{ waitRequestId: string; request: ProtectedDecisionWaitRequest }>,
  ): Map<string, ProtectedDecisionWaitRequest> {
    const byId = new Map<string, ProtectedDecisionWaitRequest>();
    for (const record of records) {
      if (!byId.has(record.waitRequestId)) {
        byId.set(record.waitRequestId, record.request);
      }
    }
    return byId;
  }

  private dedupedResumesById(
    records: ReadonlyArray<{ waitRequestId: string; authorization: ProtectedDecisionResumeAuthorization }>,
  ): Map<string, ProtectedDecisionResumeAuthorization> {
    const byId = new Map<string, ProtectedDecisionResumeAuthorization>();
    for (const record of records) {
      if (!byId.has(record.waitRequestId)) {
        byId.set(record.waitRequestId, record.authorization);
      }
    }
    return byId;
  }

  putIfAbsentWaitRequest(
    tenantId: TenantScope["tenantId"],
    waitRequestId: string,
    request: ProtectedDecisionWaitRequest,
  ): PersistResult<ProtectedDecisionWaitRequest> {
    if (waitRequestId.trim().length === 0) {
      throw new InvalidDurableProtectedDecisionWaitStoreError("waitRequestId must be a non-empty string");
    }
    if (request.tenantId !== tenantId || (request.waitRequestId as unknown as string) !== waitRequestId) {
      throw new InvalidDurableProtectedDecisionWaitStoreError(
        "request.tenantId/waitRequestId must exactly match the given tenantId/waitRequestId",
      );
    }

    const existing = this.get(tenantId, waitRequestId);
    if (existing !== undefined) {
      if (!waitRequestCoreIdentityEquals(existing, request)) {
        throw new InvalidDurableProtectedDecisionWaitStoreError(
          `waitRequestId "${waitRequestId}" is already recorded with a different wait request`,
        );
      }
      return { value: existing, created: false };
    }

    const lockPath = this.waitCreationLockPathFor(tenantId, waitRequestId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ waitRequestId, request });
    writeFileSync(tmpPath, payload, "utf8");
    let wonCreation: boolean;
    try {
      linkSync(tmpPath, lockPath);
      wonCreation = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      wonCreation = false;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only.
      }
    }

    if (!wonCreation) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      const winner = validatePersistedWaitRequest(JSON.parse(winnerRaw), tenantId, lockPath);
      if (!waitRequestCoreIdentityEquals(winner.request, request)) {
        throw new InvalidDurableProtectedDecisionWaitStoreError(
          `waitRequestId "${waitRequestId}" is already recorded under a different wait request`,
        );
      }
      if (this.get(tenantId, waitRequestId) === undefined) {
        appendFileSync(this.waitFilePathFor(tenantId), `${winnerRaw}\n`, "utf8");
      }
      return { value: winner.request, created: false };
    }

    appendFileSync(this.waitFilePathFor(tenantId), `${payload}\n`, "utf8");
    return { value: request, created: true };
  }

  get(tenantId: TenantScope["tenantId"], waitRequestId: string): ProtectedDecisionWaitRequest | undefined {
    return this.dedupedWaitRequestsById(this.readAllWaitRequests(tenantId)).get(waitRequestId);
  }

  claimResume(
    tenantId: TenantScope["tenantId"],
    waitRequestId: string,
    authorization: ProtectedDecisionResumeAuthorization,
  ): PersistResult<ProtectedDecisionResumeAuthorization> {
    if ((authorization.waitRequestId as unknown as string) !== waitRequestId) {
      throw new InvalidDurableProtectedDecisionWaitStoreError(
        "authorization.waitRequestId must exactly match the given waitRequestId",
      );
    }
    const existingWait = this.get(tenantId, waitRequestId);
    if (existingWait === undefined) {
      throw new InvalidDurableProtectedDecisionWaitStoreError(
        `no durable wait request exists for waitRequestId "${waitRequestId}" - cannot claim a resume for a wait that was never recorded`,
      );
    }
    if (existingWait.effectRef !== authorization.effectRef) {
      throw new InvalidDurableProtectedDecisionWaitStoreError(
        "authorization.effectRef does not match the recorded wait request's own effectRef",
      );
    }

    const existingResume = this.getResume(tenantId, waitRequestId);
    if (existingResume !== undefined) {
      // Single-use: a second claim for an already-resumed wait is always a
      // safe no-op returning the ORIGINAL resume, regardless of what the
      // second caller's own authorization content claims - the first
      // genuine resume is the only one that ever authorizes an effect.
      return { value: existingResume, created: false };
    }

    const lockPath = this.resumeCreationLockPathFor(tenantId, waitRequestId);
    const tmpPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify({ waitRequestId, authorization });
    writeFileSync(tmpPath, payload, "utf8");
    let wonCreation: boolean;
    try {
      linkSync(tmpPath, lockPath);
      wonCreation = true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
        throw cause;
      }
      wonCreation = false;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup only.
      }
    }

    if (!wonCreation) {
      const winnerRaw = readFileSync(lockPath, "utf8");
      const winner = validatePersistedResumeAuthorization(JSON.parse(winnerRaw), waitRequestId, lockPath);
      if (this.getResume(tenantId, waitRequestId) === undefined) {
        appendFileSync(this.resumeFilePathFor(tenantId), `${winnerRaw}\n`, "utf8");
      }
      return { value: winner.authorization, created: false };
    }

    appendFileSync(this.resumeFilePathFor(tenantId), `${payload}\n`, "utf8");
    return { value: authorization, created: true };
  }

  getResume(tenantId: TenantScope["tenantId"], waitRequestId: string): ProtectedDecisionResumeAuthorization | undefined {
    return this.dedupedResumesById(this.readAllResumes(tenantId)).get(waitRequestId);
  }
}
