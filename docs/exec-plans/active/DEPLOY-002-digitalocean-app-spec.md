# DEPLOY-002 — DigitalOcean App Platform Spec Candidate (Connected Dark activation, step 2)

## Provenance

- Governing authority: same Founder "GREENLIGHT — proceed with the deployment/integration phase now" instruction as DEPLOY-001, plus the Founder's standing "CONTINUOUS WORK RULE" (prepare the next dependency-safe step while a credential/account gate is outstanding, rather than idling).
- As of this checkpoint, no DigitalOcean API token or Cloudflare connector has reached this execution surface (`ListConnectors` shows neither; an environment-variable scan finds no `DIGITALOCEAN_ACCESS_TOKEN`/`CLOUDFLARE_*`). This checkpoint is therefore preparation only — no DigitalOcean account, app, or resource is created, and none can be from here yet.
- Branch: `claude/deploy-002-do-app-spec`, cut from `main` at `11caf9fd42061c354e3327600084406c677788f4`.

## Scope (this checkpoint)

- `deploy/digitalocean/app.yaml.example` — a DigitalOcean App Platform spec candidate, `.example` suffix (not a live binding), matching the same convention RUNTIME-001 already established for `deploy/cloudflare/wrangler.toml.example`.
- One `web` service only, pulling the exact-SHA image DEPLOY-001's `publish-image` CI job will push to GHCR (`ghcr.io/jay-prodesign/akil-main`), configured entirely through `src/runtime/app-config.ts`'s own existing env vars (`PORT`, `DEPLOYMENT_ENV`, `PERSISTENCE_DRIVER`) — no second config model invented.
- `PERSISTENCE_DRIVER=FILE` deliberately: `createNodeRuntime()` (RUNTIME-001) always serves the fixture-backed web-shell regardless of this value, so setting `POSTGRES` here would falsely claim a database wiring that does not exist. A TCP health check is used, not an `http_path`, since no HTTP `/health` route exists on this runtime yet (AA-002's own "SAFE DARK LIMIT" note).

## Explicitly deferred (not fabricated)

- **No `workers:` entry.** The canonical target topology (AA-002) names a non-public WORKER component, but no background-job worker executable exists anywhere in `src/` — there is nothing for such an entry to run. Adding one here would describe a deployment artifact with no code behind it.
- **No `jobs:` PRE_DEPLOY migration entry.** `migrations/0001_outcome_jobs.sql` exists but has never been applied against a real database by any checkpoint in this repository (RUNTIME-001/DEP-ORCH-001 both explicitly defer this). A migration job with nothing to migrate would be theater, not infrastructure.
- **No `databases:` (Managed PostgreSQL) entry.** Attaching one is only honest once `AsyncOutcomeJobStore`/`PostgresOutcomeJobStore` are actually wired into a real domain call site — RUNTIME-001 explicitly left that undone, and nothing in this checkpoint changes it.
- **No `domains:` entry.** Per AA-002's DOMAIN TOPOLOGY section, `app.akilta.com` DNS is configured on the Cloudflare side (pointed at this app's DigitalOcean-issued ingress hostname once the app exists), not inside the App Platform spec itself.
- **No DigitalOcean account, app, or resource created.** This file is never applied by this checkpoint; `doctl apps create`/the App Platform console action remains a later, explicit, credential-gated step.

## Status

**IMPLEMENTED / SELF-VALIDATED** (spec file + docs only; no source/test file changed, `npm run build`/`npm run test`/`npx tsc --noEmit` all still pass unmodified at `11caf9fd...` + this change). Pending: (1) a DigitalOcean API token reaching this execution surface before the spec can actually be applied; (2) DEPLOY-001's GHCR image existing (gated on the GitHub Actions dispatch fix); (3) Brain/Founder review per `AGENTS.md` §10.
