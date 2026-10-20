# DEPLOY-001 — Immutable GHCR Image Publish (Connected Dark activation, step 1)

## Provenance

- Governing authority: Founder's explicit "GREENLIGHT — proceed with the deployment/integration phase now" instruction, following the independent Brain V1 PASS/VERIFIED exit review and the Founder-authorized merge of the complete V1 lineage to `main` (final head `c792f823c6874c970733e0a4ffaa1b1341193530`, then PR #135 docs sync to `11caf9fd42061c354e3327600084406c677788f4`).
- Target topology and sequencing are not invented here. They are the already-admitted "TARGET TOPOLOGY CONFIRMED" / "TARGET STACK" / "DEPLOYMENT FLOW" / "AUTOMATION / FOUNDER-ZERO-TOUCH DEPLOYMENT RULE" sections of the canonical AA-002 "AKILTA — Current Project State" document (Connected Dark activation packet, admitted 2026-09-26, re-confirmed applicable now that the OS-V0-06+ entry gate and the full V1 lineage are independently PASS/VERIFIED): *"Build once from an exact reviewed SHA, preferably as an immutable container image through GitHub Actions + GHCR, then deploy that same artifact to DigitalOcean App Platform."*
- Branch: `claude/deploy-001-ghcr-image-publish`, cut from `main` at `11caf9fd42061c354e3327600084406c677788f4`.

## Scope (this checkpoint)

- `.github/workflows/ci.yml`: adds a `publish-image` job, gated on `build-and-test` passing and `push` to `main` only (never on a PR, never a different ref) — builds `deploy/docker/Dockerfile` (RUNTIME-001's existing, unmodified Node-runtime container candidate) and pushes it to GHCR (`ghcr.io/jay-prodesign/akil-main`) tagged with both the exact commit SHA (immutable) and `main` (convenience/floating pointer for the latest reviewed build).
- Uses the repository's own ambient `GITHUB_TOKEN` (scoped to `packages: write` for this job only) — no new secret, no DigitalOcean/Cloudflare credential, no account touched.

## Explicitly deferred (not fabricated)

- **No DigitalOcean App Platform, Managed PostgreSQL, or Cloudflare resource created, modified, or referenced anywhere in this checkpoint.** Those remain their own later checkpoints, gated on the Founder's DigitalOcean API token / Cloudflare connector actually reaching this execution surface (neither was present as of this checkpoint — confirmed by `ListConnectors` showing only Shopify connected, and an environment-variable scan finding no `DIGITALOCEAN_ACCESS_TOKEN`/`CLOUDFLARE_*`).
- **No image is deployed or run anywhere beyond GHCR storage.** Pushing to GHCR only makes the exact reviewed artifact available for a later DigitalOcean App Platform pull; it is not itself a deploy.
- **No modification to `deploy/docker/Dockerfile`, `deploy/cloudflare/wrangler.toml.example`, or any `src/`/`tests/` file.** This checkpoint only wires the existing, unmodified Dockerfile into CI.
- **No local Docker build was run to pre-validate the image in this session** — no Docker daemon is reachable in this sandbox (`docker info` fails; only the CLI binary is present). The build is validated by GitHub Actions' own Docker environment on the first real `push`-to-`main` run of this workflow, which will be watched after this PR merges.

## Hard Non-Scope

No DigitalOcean/Cloudflare account, credential, or API call. No live deploy. No DNS. No billing/spend. No change to application source code, tests, or the existing Dockerfile contents.

## Status

**IMPLEMENTED / SELF-VALIDATED** (workflow YAML only; `npm run build`/`npm run test`/`npx tsc --noEmit` all still pass unmodified at `11caf9fd...` + this change, since no source file changed). Pending: (1) Brain/Founder review per `AGENTS.md` §10 — Claude's authority ends at `IMPLEMENTED`; (2) the first real CI run of `publish-image` on a push to `main`, to be watched and recorded here once this merges.

## Follow-up fix (first real `publish-image` run)

- Actions dispatch was blocked by an account billing/spending-limit annotation on every run while the repo was private ("The job was not started because recent account payments have failed or your spending limit needs to be increased"). Founder resolved it by making the repository public (2026-10-10); full history was scanned for credential patterns first and only test-fixture markers were found.
- PR #136 merged as `945d35c`; PR #137 merged as `5dcbee9`. The first `publish-image` run on `main` (run `38033287134`) failed: `invalid tag "ghcr.io/Jay-prodesign/akil-main:…": repository name must be lowercase`. `github.repository` preserves owner casing, so the job now lowercases it into `IMAGE` before tagging.
