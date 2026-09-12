import type { TenantScope } from "./tenant-scope.js";
import type { AppConfig } from "../runtime/app-config.js";
import type { SecretRef } from "./connection-authority.js";

export class InvalidDeploymentOrchestrationError extends Error {
  constructor(reason: string) {
    super(`Invalid deployment orchestration operation: ${reason}`);
    this.name = "InvalidDeploymentOrchestrationError";
  }
}

export class InvalidCutoverTransitionError extends Error {
  constructor(reason: string) {
    super(`Invalid cutover transition: ${reason}`);
    this.name = "InvalidCutoverTransitionError";
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidDeploymentOrchestrationError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireStringRefArray(value: unknown, field: string): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((ref) => typeof ref !== "string" || ref.trim().length === 0)) {
    throw new InvalidDeploymentOrchestrationError(
      `${field} must be an array of non-empty strings (an empty array is valid)`,
    );
  }
  return value as ReadonlyArray<string>;
}

/**
 * Rev98 gap-audit Family 11 ("V5 WORKSTREAM E — DEPLOYMENT ORCHESTRATION
 * COMPLETION beyond RUNTIME-001"): *"environment inventory, provider-
 * neutral config, drift/preflight, migrations/cutover, secret refs, DNS
 * proposal, rollback and readback artifacts without live deploy."*
 *
 * This module never performs a live deploy, migration, traffic switch,
 * or DNS mutation - every action here is a record of an intended or
 * observed state, composing `RUNTIME-001`'s own unmodified `AppConfig`
 * (provider-neutral config) and `connection-authority.ts`'s own
 * unmodified `SecretRef` (opaque secret pointers) rather than inventing
 * a second config or secret-reference model.
 */
export interface DeploymentEnvironmentRegistration {
  readonly tenantId: TenantScope["tenantId"];
  readonly environmentRef: string;
  readonly tier: AppConfig["deploymentEnv"];
  readonly boundSecretRefs: ReadonlyArray<SecretRef["secretRefId"]>;
}

/**
 * §"environment inventory": binds an opaque `environmentRef` (e.g.
 * "prod-us", "staging-eu") to exactly one `AppConfig["deploymentEnv"]`
 * tier and the `SecretRef`s it depends on - no environment is ever born
 * bound to more than one tier, and no raw secret value is ever accepted
 * here, only opaque `SecretRef` pointers.
 */
export function registerDeploymentEnvironment(input: {
  tenantScope: TenantScope;
  environmentRef: unknown;
  tier: unknown;
  boundSecretRefs: ReadonlyArray<unknown>;
}): DeploymentEnvironmentRegistration {
  const environmentRef = requireNonEmptyString(input.environmentRef, "environmentRef");
  if (input.tier !== "development" && input.tier !== "staging" && input.tier !== "production") {
    throw new InvalidDeploymentOrchestrationError('tier must be one of "development"/"staging"/"production"');
  }
  const boundSecretRefs = requireStringRefArray(input.boundSecretRefs, "boundSecretRefs");
  return {
    tenantId: input.tenantScope.tenantId,
    environmentRef,
    tier: input.tier,
    boundSecretRefs: boundSecretRefs as ReadonlyArray<SecretRef["secretRefId"]>,
  };
}

/**
 * §"drift/preflight": a pure, caller-supplied comparison - this module
 * never reads a live environment itself. `desired` is the environment's
 * own declared `AppConfig`; `observed` is whatever the caller separately
 * determined the environment actually reports. Drift on `databaseUrl` is
 * reported only by presence/absence, never by comparing the actual
 * connection string values (which would require this module to see
 * real credential material it has no business holding).
 */
export type ConfigDriftStatus = "NO_DRIFT" | "DRIFT_DETECTED";

export interface ConfigDriftReport {
  readonly status: ConfigDriftStatus;
  readonly driftedFields: ReadonlyArray<string>;
}

export function resolveConfigDrift(input: { desired: AppConfig; observed: AppConfig }): ConfigDriftReport {
  const driftedFields: string[] = [];
  if (input.desired.port !== input.observed.port) {
    driftedFields.push("port");
  }
  if (input.desired.deploymentEnv !== input.observed.deploymentEnv) {
    driftedFields.push("deploymentEnv");
  }
  if (input.desired.persistenceDriver !== input.observed.persistenceDriver) {
    driftedFields.push("persistenceDriver");
  }
  if ((input.desired.databaseUrl !== undefined) !== (input.observed.databaseUrl !== undefined)) {
    driftedFields.push("databaseUrl");
  }
  return {
    status: driftedFields.length === 0 ? "NO_DRIFT" : "DRIFT_DETECTED",
    driftedFields,
  };
}

/**
 * §"migrations/cutover ... rollback and readback artifacts": a strictly
 * closed lifecycle. `PLANNED` can only advance to `PREFLIGHT_PASSED`
 * once a `ConfigDriftReport` proves `NO_DRIFT` - a cutover can never
 * proceed past planning while the environment's actual config disagrees
 * with what was declared. Every non-terminal state can be aborted to
 * `ROLLED_BACK` via the explicit, governed `initiateRollback`; `VERIFIED`
 * is only reachable through `verifyCutoverReadback` confirming health,
 * matching this codebase's own "readback is authoritative over a claimed
 * outcome" discipline (`external-effect-envelope.ts`) - a disproving
 * readback corrects the plan to `ROLLED_BACK` rather than leaving it
 * falsely advanced.
 */
export type CutoverStatus =
  | "PLANNED"
  | "PREFLIGHT_PASSED"
  | "MIGRATIONS_APPLIED"
  | "TRAFFIC_SWITCHED"
  | "VERIFIED"
  | "ROLLED_BACK";

const TERMINAL_CUTOVER_STATUSES: ReadonlySet<CutoverStatus> = new Set(["VERIFIED", "ROLLED_BACK"]);

export interface CutoverPlan {
  readonly tenantId: TenantScope["tenantId"];
  readonly cutoverRef: string;
  readonly environmentRef: string;
  readonly migrationRefs: ReadonlyArray<string>;
  readonly status: CutoverStatus;
  readonly rollbackReason?: string;
  readonly readbackEvidenceRef?: string;
}

export function createCutoverPlan(input: {
  environment: DeploymentEnvironmentRegistration;
  migrationRefs: ReadonlyArray<unknown>;
  cutoverRef: unknown;
}): CutoverPlan {
  const cutoverRef = requireNonEmptyString(input.cutoverRef, "cutoverRef");
  const migrationRefs = requireStringRefArray(input.migrationRefs, "migrationRefs");
  return {
    tenantId: input.environment.tenantId,
    cutoverRef,
    environmentRef: input.environment.environmentRef,
    migrationRefs,
    status: "PLANNED",
  };
}

/**
 * The one required gate: a cutover can never leave `PLANNED` while its
 * own environment's config is drifted from what was declared.
 */
export function passPreflight(input: { plan: CutoverPlan; driftReport: ConfigDriftReport }): CutoverPlan {
  if (input.plan.status !== "PLANNED") {
    throw new InvalidCutoverTransitionError(
      `preflight can only be evaluated for a PLANNED cutover (current status: ${input.plan.status})`,
    );
  }
  if (input.driftReport.status !== "NO_DRIFT") {
    throw new InvalidCutoverTransitionError(
      `cutover cannot proceed past PLANNED while config drift is detected: ${input.driftReport.driftedFields.join(", ")}`,
    );
  }
  return { ...input.plan, status: "PREFLIGHT_PASSED" };
}

export function markMigrationsApplied(input: { plan: CutoverPlan; evidenceRef: unknown }): CutoverPlan {
  if (input.plan.status !== "PREFLIGHT_PASSED") {
    throw new InvalidCutoverTransitionError(
      `migrations can only be marked applied for a PREFLIGHT_PASSED cutover (current status: ${input.plan.status})`,
    );
  }
  requireNonEmptyString(input.evidenceRef, "evidenceRef");
  return { ...input.plan, status: "MIGRATIONS_APPLIED" };
}

export function markTrafficSwitched(input: { plan: CutoverPlan; evidenceRef: unknown }): CutoverPlan {
  if (input.plan.status !== "MIGRATIONS_APPLIED") {
    throw new InvalidCutoverTransitionError(
      `traffic can only be switched for a MIGRATIONS_APPLIED cutover (current status: ${input.plan.status})`,
    );
  }
  requireNonEmptyString(input.evidenceRef, "evidenceRef");
  return { ...input.plan, status: "TRAFFIC_SWITCHED" };
}

/**
 * §"readback artifacts", mirroring `verifyExternalEffectReadback`'s own
 * discipline exactly: only an independent readback that actually
 * confirms the cutover is healthy can move it to `VERIFIED`. A readback
 * that disproves health corrects the plan to `ROLLED_BACK` instead of
 * leaving it falsely `TRAFFIC_SWITCHED`/advanced.
 */
export function verifyCutoverReadback(input: {
  plan: CutoverPlan;
  readbackConfirmsHealthy: unknown;
  evidenceRef: unknown;
}): CutoverPlan {
  if (input.plan.status !== "TRAFFIC_SWITCHED") {
    throw new InvalidCutoverTransitionError(
      `readback can only be recorded for a TRAFFIC_SWITCHED cutover (current status: ${input.plan.status})`,
    );
  }
  if (typeof input.readbackConfirmsHealthy !== "boolean") {
    throw new InvalidDeploymentOrchestrationError("readbackConfirmsHealthy must be a boolean");
  }
  const readbackEvidenceRef = requireNonEmptyString(input.evidenceRef, "evidenceRef");
  if (!input.readbackConfirmsHealthy) {
    return { ...input.plan, status: "ROLLED_BACK", readbackEvidenceRef };
  }
  return { ...input.plan, status: "VERIFIED", readbackEvidenceRef };
}

/**
 * §"rollback ... artifacts": the governed, explicit abort path from any
 * non-terminal status. Fails closed once the plan has already reached a
 * terminal status (`VERIFIED`/`ROLLED_BACK`) - a verified or
 * already-rolled-back cutover cannot be rolled back again.
 */
export function initiateRollback(input: {
  plan: CutoverPlan;
  reason: unknown;
  evidenceRef: unknown;
}): CutoverPlan {
  if (TERMINAL_CUTOVER_STATUSES.has(input.plan.status)) {
    throw new InvalidCutoverTransitionError(
      `cannot roll back a cutover that has already reached a terminal status (current status: ${input.plan.status})`,
    );
  }
  const reason = requireNonEmptyString(input.reason, "reason");
  requireNonEmptyString(input.evidenceRef, "evidenceRef");
  return { ...input.plan, status: "ROLLED_BACK", rollbackReason: reason };
}

/**
 * §"DNS proposal": always born `PROPOSED`, and this module never applies
 * a DNS change - there is no function anywhere in this module that
 * transitions a proposal to an "applied"/"live" state, matching Rev98's
 * own "without live deploy" scope exactly.
 */
export type DnsChangeProposalStatus = "PROPOSED" | "WITHDRAWN";
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX";

const RECOGNIZED_DNS_RECORD_TYPES: ReadonlySet<DnsRecordType> = new Set(["A", "AAAA", "CNAME", "TXT", "MX"]);

export interface DnsChangeProposal {
  readonly tenantId: TenantScope["tenantId"];
  readonly environmentRef: string;
  readonly recordType: DnsRecordType;
  readonly name: string;
  readonly target: string;
  readonly ttlSeconds: number;
  readonly status: DnsChangeProposalStatus;
}

export function proposeDnsChange(input: {
  environment: DeploymentEnvironmentRegistration;
  recordType: unknown;
  name: unknown;
  target: unknown;
  ttlSeconds: unknown;
}): DnsChangeProposal {
  if (!RECOGNIZED_DNS_RECORD_TYPES.has(input.recordType as DnsRecordType)) {
    throw new InvalidDeploymentOrchestrationError(
      `recordType must be one of ${Array.from(RECOGNIZED_DNS_RECORD_TYPES).join(", ")}`,
    );
  }
  const name = requireNonEmptyString(input.name, "name");
  const target = requireNonEmptyString(input.target, "target");
  if (typeof input.ttlSeconds !== "number" || !Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new InvalidDeploymentOrchestrationError("ttlSeconds must be a positive integer");
  }
  return {
    tenantId: input.environment.tenantId,
    environmentRef: input.environment.environmentRef,
    recordType: input.recordType as DnsRecordType,
    name,
    target,
    ttlSeconds: input.ttlSeconds,
    status: "PROPOSED",
  };
}

export function withdrawDnsChangeProposal(proposal: DnsChangeProposal): DnsChangeProposal {
  if (proposal.status !== "PROPOSED") {
    throw new InvalidDeploymentOrchestrationError(
      `only a PROPOSED DNS change can be withdrawn (current status: ${proposal.status})`,
    );
  }
  return { ...proposal, status: "WITHDRAWN" };
}
