# DEPLOY-003 — HTTP /health Route (closes AA-002's SAFE DARK LIMIT gap)

## Provenance

- Governing authority: Founder's standing deployment-phase authorization plus the explicit "you can go ahead and start on the next steps/developments in the meantime" instruction given while the DigitalOcean/Cloudflare credential and GitHub billing gates remain outstanding (CONTINUOUS WORK RULE — use the time productively within the already-authorized deployment milestone, don't invent unrelated scope).
- Not invented scope: AA-002's own "SAFE DARK LIMIT" section explicitly names this exact gap — *"There is no dedicated HTTP `/health` route on the current runtime, but DigitalOcean supports TCP health checks when no `http_path` is configured."* DEPLOY-002's `app.yaml.example` recorded the same gap and used a TCP-only check as a result. Closing it is completing an already-identified, already-cited deployment prerequisite — not a new feature or architecture decision.
- Branch: `claude/deploy-003-http-health-route`, cut from `main` at `5dcbee99e3f0a0455915a7785ac939b069c1e33a`.

## Scope (this checkpoint)

- `src/web/http-server.ts`: adds an optional `healthCheck?: () => HealthProbeResponse` dep (`HealthProbeResponse = { healthy: boolean; body: string }` — a deliberately plain shape, not an import of `runtime/health-check.ts`'s `HealthCheckResult`, keeping this module decoupled from the runtime layer per its own existing "only translates a real socket request/response" responsibility, ADR 0001). When present, `GET /health` is intercepted *before* any session/snapshot translation — health checks are a transport-level concern and must never require authentication — and responds `200`/`503` with the probe's JSON body. Any other path, or `/health` under a non-GET method, or no `healthCheck` configured at all, falls through to the existing, completely unmodified `handleRequest` path.
- `src/runtime/node-server-entrypoint.ts`: `createNodeRuntime` now wires `healthCheck` to the module's own pre-existing `health(config)` function (RUNTIME-001), mapping `HealthCheckResult` → `{ healthy: status !== "UNHEALTHY", body: JSON.stringify(result) }`. No new health logic — `evaluateHealth`'s aggregation is reused verbatim.
- `tests/http-server.test.ts` (new, 4 tests: H1–H4) and two new tests in `tests/node-server-entrypoint.test.ts` (N4, end-to-end over a real ephemeral port).
- `deploy/digitalocean/app.yaml.example` (DEPLOY-002): health check switched from a bare TCP probe to `http_path: /health`, now that the route genuinely exists.

## Explicitly deferred (not fabricated)

- **No change to `request-handler.ts`.** It remains the read-only dependency every prior checkpoint (RUNTIME-001, DEP-ORCH-001, Family 5, ...) has kept it as. The health route is intercepted one layer up, in the Node-specific transport file, exactly where ADR 0001 already says socket-level concerns belong.
- **No new health probe content.** `/health`'s body is the exact same `HealthCheckResult` (`status`, `probes`) RUNTIME-001's `health(config)` already produces — today that's a single `config` probe, always healthy for any config that resolved at all. Adding real probes (database reachability, external dependency checks) is separate, later work once those dependencies exist.
- **No Cloudflare Worker wiring.** `cloudflare-worker-fetch-adapter.ts` is untouched; this checkpoint is Node-runtime-only, matching DEPLOY-002's own scope (App Platform targets the Node path, not Workers, per AA-002's own topology note).

## Architecture / semantic invariants (verified by test)

- `GET /health` with no `healthCheck` configured falls through to the ordinary 404 (H1) — opt-in only, never a behavior change for an unconfigured caller.
- `GET /health` with a healthy probe returns 200 + the probe's exact body, unauthenticated (H2).
- `GET /health` with an unhealthy probe returns 503 (H3).
- A non-GET `/health` request never invokes `healthCheck` at all — it falls through to the normal handler's existing method rejection (H4, counter-asserted).
- The booted `createNodeRuntime` server serves `GET /health` as 200/`HEALTHY` with no session token, over a real ephemeral local port (N4).
- Sanity-checked: the `/health` path match was temporarily broken (renamed to a non-matching string), confirming H2/H3/N4 then fail (404 instead of 200/503) while H1/H4 (which assert fall-through behavior) correctly still pass; the fix was restored and the full 2669/2669 regression reconfirmed passing.

## Hard Non-Scope

No modification to `request-handler.ts`, `session-context.ts`, `production-session-provider.ts`, `dev-fixture-session-provider.ts`, or any domain file. No new runtime dependency. No DigitalOcean/Cloudflare account, credential, or live deploy — `app.yaml.example` remains exactly that, an example.

## Evidence

- `npm run build` (`tsc -p tsconfig.json`, strict mode): exit 0, zero errors.
- `npx tsc --noEmit -p .`: exit 0.
- `node --test dist/tests/*.test.js`: **2669/2669 passing** (2664 pre-existing baseline at `5dcbee99...` + 5 new: 4 in `tests/http-server.test.ts`, 1 in `tests/node-server-entrypoint.test.ts`).
- Sanity-checked adversarial test: the `/health` path-match guard was temporarily disabled (renamed to a non-matching path string); confirmed exactly the 3 tests that depend on the route actually matching (H2, H3, N4) then failed with 404 instead of 200/503, while H1/H4 (fall-through assertions) still passed; the guard was restored and 2669/2669 reconfirmed.
- `package.json`: zero new runtime dependency.
- Files touched: `src/web/http-server.ts`, `src/runtime/node-server-entrypoint.ts`, `tests/http-server.test.ts` (new), `tests/node-server-entrypoint.test.ts`, `deploy/digitalocean/app.yaml.example`, this exec-plan.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder review per `AGENTS.md` §10; Claude's authority ends at this status. `MERGE_DISPOSITION`: routine technical work within the already Founder-authorized deployment milestone (same basis as DEPLOY-001/DEPLOY-002) — not gated on a separate merge approval beyond that standing authorization.
