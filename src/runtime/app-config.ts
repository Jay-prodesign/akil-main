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
}

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

  return {
    port,
    deploymentEnv: rawDeploymentEnv,
    persistenceDriver,
    ...(databaseUrl !== undefined ? { databaseUrl } : {}),
  };
}
