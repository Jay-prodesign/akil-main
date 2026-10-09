import type { Server } from "node:http";
import { createHttpServer } from "../web/http-server.js";
import { resolveAppConfig, type AppConfig } from "./app-config.js";
import { evaluateHealth, type HealthCheckResult } from "./health-check.js";
import {
  createWebShellFixtureSnapshotSource,
  createWebShellFixtureTeamAttentionSource,
  WEB_SHELL_DEV_SESSION_FIXTURES,
} from "../fixtures/web-shell.js";

/**
 * RUNTIME-001: the one Node-hosting-target adapter that turns a resolved
 * `AppConfig` into an actually-listening server. This is deliberately a
 * *bootstrap* runtime, not a production data-wiring decision: it serves
 * the existing shell using the same `createWebShellFixtureSnapshotSource`/
 * `createWebShellFixtureTeamAttentionSource` fixtures the dev session
 * provider already uses (`src/fixtures/web-shell.ts`), proving the
 * runtime boundary itself (config resolution, health reporting, listen)
 * boots correctly end-to-end. Wiring a real, persistence-backed
 * `ClientProjectSnapshotSource` (whether FILE- or POSTGRES-driven, per
 * `config.persistenceDriver`) is an explicit, disclosed, later decision -
 * not fabricated here, since no such source exists yet.
 */
export function health(config: AppConfig): HealthCheckResult {
  return evaluateHealth([
    { name: "config", healthy: true, critical: true, detail: `deploymentEnv=${config.deploymentEnv}` },
  ]);
}

export function createNodeRuntime(config: AppConfig): { readonly server: Server; readonly health: () => HealthCheckResult } {
  const server = createHttpServer({
    isProduction: config.deploymentEnv === "production",
    devSessionFixtures: WEB_SHELL_DEV_SESSION_FIXTURES,
    snapshotSource: createWebShellFixtureSnapshotSource(),
    teamAttentionSource: createWebShellFixtureTeamAttentionSource(),
  });
  return { server, health: () => health(config) };
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
}

if (isMainModule()) {
  const config = resolveAppConfig(process.env);
  const runtime = createNodeRuntime(config);
  runtime.server.listen(config.port, () => {
    console.log(`AKILTA runtime listening on port ${config.port} (${config.deploymentEnv})`);
  });
}
