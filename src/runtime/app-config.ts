export class InvalidAppConfigError extends Error {
  constructor(reason: string) {
    super(`Invalid application runtime configuration: ${reason}`);
    this.name = "InvalidAppConfigError";
  }
}

export type PersistenceDriver = "FILE" | "POSTGRES";

const RECOGNIZED_PERSISTENCE_DRIVERS: ReadonlySet<PersistenceDriver> = new Set([
  "FILE",
  "POSTGRES",
]);

/**
 * Provider-neutral runtime configuration contract: every field here is
 * something any hosting target (a plain Node process, a container, a
 * Cloudflare Worker) could in principle supply through its own env/secret
 * mechanism. Nothing here names a specific cloud account, region, or
 * credential value - resolving THIS shape from a live environment is the
 * hosting target's own adapter's job, not this module's.
 */
export interface AppConfig {
  readonly port: number;
  readonly deploymentEnv: "development" | "staging" | "production";
  readonly persistenceDriver: PersistenceDriver;
  readonly databaseUrl?: string;
  /**
   * C1 (runtime composition root, FILE driver): the single root directory
   * every `FileDurable*` store the deployable runtime composes is rooted
   * under (one fixed subdirectory per store - see
   * `runtime/file-durable-runtime-stores.ts`). Kept as the raw configured
   * string here - resolving it against a working directory is the Node
   * hosting adapter's own job (`node-server-entrypoint.ts`), so this module
   * stays importable on a host with no filesystem (a Worker isolate).
   * Defaults to `DEFAULT_FILE_DATA_DIR`, exactly like `PORT`/
   * `DEPLOYMENT_ENV`/`PERSISTENCE_DRIVER` default when absent; a supplied
   * but empty/whitespace-only value fails closed.
   */
  readonly dataDir: string;
  /**
   * C1: which Organization's ledger (`FileDurableControlledOrganizationProvisioningStore`,
   * OS-V1-01) the staff `/os` surface renders. This identifies the
   * organization only - the `Organization` value itself (display name,
   * lifecycle state) is always re-read from the durable provisioning
   * ledger per request, never taken from configuration. Absent means the
   * deployment has no internal-OS organization, and every `/os` route
   * renders `NOT_FOUND`. Both env vars must be supplied together.
   */
  readonly internalOsOrganization?: {
    readonly tenantId: string;
    readonly organizationId: string;
  };
}

/** C1: the FILE-driver data root used when `DATA_DIR` is not supplied (resolved against the process working directory by the Node adapter). */
export const DEFAULT_FILE_DATA_DIR = ".akilta-data";

function requireNonEmptyString(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidAppConfigError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Fails closed on every malformed input rather than silently defaulting -
 * a runtime should never boot into a guessed configuration. `env` is
 * accepted as a plain string-keyed record (not `process.env` directly) so
 * this function stays importable and testable on any host, including one
 * with no `process` global (a Worker isolate).
 */
export function resolveAppConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const rawPort = requireNonEmptyString(env["PORT"] ?? "8080", "PORT");
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidAppConfigError(`PORT must be an integer between 1 and 65535, got: ${rawPort}`);
  }

  const rawDeploymentEnv = env["DEPLOYMENT_ENV"] ?? "development";
  if (rawDeploymentEnv !== "development" && rawDeploymentEnv !== "staging" && rawDeploymentEnv !== "production") {
    throw new InvalidAppConfigError(
      `DEPLOYMENT_ENV must be one of "development"/"staging"/"production", got: ${rawDeploymentEnv}`,
    );
  }

  const rawDriver = env["PERSISTENCE_DRIVER"] ?? "FILE";
  if (!RECOGNIZED_PERSISTENCE_DRIVERS.has(rawDriver as PersistenceDriver)) {
    throw new InvalidAppConfigError(
      `PERSISTENCE_DRIVER must be one of "FILE"/"POSTGRES", got: ${rawDriver}`,
    );
  }
  const persistenceDriver = rawDriver as PersistenceDriver;

  const databaseUrl = env["DATABASE_URL"];
  if (persistenceDriver === "POSTGRES") {
    requireNonEmptyString(databaseUrl, "DATABASE_URL (required when PERSISTENCE_DRIVER=POSTGRES)");
  }

  const rawDataDir = env["DATA_DIR"];
  const dataDir =
    rawDataDir === undefined ? DEFAULT_FILE_DATA_DIR : requireNonEmptyString(rawDataDir, "DATA_DIR");

  const rawOsTenantId = env["INTERNAL_OS_TENANT_ID"];
  const rawOsOrganizationId = env["INTERNAL_OS_ORGANIZATION_ID"];
  let internalOsOrganization: AppConfig["internalOsOrganization"];
  if (rawOsTenantId !== undefined || rawOsOrganizationId !== undefined) {
    // Supplying either one requires both: `requireNonEmptyString` already
    // fails closed on the missing (undefined) half, so no separate pairing
    // check is added here (it would be dead code, per C1's guard-disable
    // sanity).
    internalOsOrganization = {
      tenantId: requireNonEmptyString(rawOsTenantId, "INTERNAL_OS_TENANT_ID"),
      organizationId: requireNonEmptyString(rawOsOrganizationId, "INTERNAL_OS_ORGANIZATION_ID"),
    };
  }

  return {
    port,
    deploymentEnv: rawDeploymentEnv,
    persistenceDriver,
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
    dataDir,
    ...(internalOsOrganization !== undefined ? { internalOsOrganization } : {}),
  };
}
