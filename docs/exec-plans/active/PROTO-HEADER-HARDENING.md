# PROTO-HEADER-HARDENING — prototype-shaped HTTP header name hardening

## Provenance

- Rescued from abandoned PR #96 (`REV66 — Founder-directed bounded software completion-confidence audit`), itself stacked on the abandoned APP-I18N-001/APP-SUB-001 chain. Brain's own review of this specific finding (recorded in that PR's history) accepted it; it never landed on `main` only because its branch went stale, not because of any defect.
- Independently re-verified against current `main` before porting (not assumed from the old PR's own claim): `durable-connector-connection-store.ts`'s sibling fix (`Object.create(null)` for its two dictionary constructions) is **already present on `main`** — no rescue needed there, that part of the old audit already landed through a different path. But `src/web/http-server.ts` and `src/runtime/cloudflare-worker-fetch-adapter.ts` **still** construct their incoming-header dictionary as a plain `{}` literal — confirmed by direct inspection of both files on `main` before writing any fix.
- Branch: `claude/proto-header-hardening-v2`, cut fresh from `main` at `5dcbee99e3f0a0455915a7785ac939b069c1e33a`.

## The defect

An incoming HTTP request header name is fully caller-controlled; `__proto__` is a legal HTTP token (RFC 7230). Both `createHttpServer` (`http-server.ts`) and `toIncomingRequestLike` (`cloudflare-worker-fetch-adapter.ts`) copied headers into a plain `{}`-literal dictionary via `headers[key] = value`. Assigning a **string** value to `headers["__proto__"]` on a plain object invokes `Object.prototype`'s special `__proto__` accessor setter, which — per the ECMAScript Annex B specification — silently no-ops for a non-object/non-null value. The header is silently and completely discarded (`hasOwnProperty` is `false`) before it ever reaches the request handler, rather than throwing or corrupting anything. This is a genuine, source-proven "caller data silently dropped" defect — lower severity than a true prototype-pollution corruption (no object-value assignment occurs here, so the dictionary's own prototype is never reassigned), but still a real correctness gap: any code path that depends on reading a `__proto__`-named header (unusual, but legal) would silently see it as absent.

## Fix

Both files now construct their headers dictionary via `Object.create(null)` instead of `{}`. A null-prototype object inherits nothing from `Object.prototype` — no `__proto__` accessor, no `constructor`, no `toString` — so every header name, including prototype-shaped ones, behaves as an ordinary own data property. This changes no observable behavior for any ordinary header name.

## Scope (this checkpoint)

- `src/web/http-server.ts`: the inline per-request `headers` dictionary now uses `Object.create(null)`.
- `src/runtime/cloudflare-worker-fetch-adapter.ts`: `toIncomingRequestLike`'s `headers` dictionary now uses `Object.create(null)`.
- `tests/cloudflare-worker-fetch-adapter.test.ts`: new test **W4** — a request header literally named `"__proto__"` (and `"constructor"`) is preserved as a real, retrievable own-property header value, proven directly against the real Fetch API `Request`/`Headers` implementation (not a hand-built stand-in).
- `IMPLEMENTED / SELF-VALIDATED`: clean build, clean strict typecheck, full regression **2665/2665 passing** (2664 pre-existing + 1 new), zero new runtime dependency.

## Honest limitation (disclosed, not hidden)

`http-server.ts`'s own fix could **not** be proven via a live end-to-end socket test: both `fetch()` and `node:http`'s own HTTP client silently strip a `__proto__`-named header *before it is ever transmitted* — independently verified empirically in this session (a client-tooling limitation, not a repo-code one; the server-side `req.headers` never contains it regardless of this file's own code). The fix is kept for correctness/consistency/defense-in-depth with `cloudflare-worker-fetch-adapter.ts` (proven harmless for every ordinary header name by the existing `tests/http-server.test.ts`/`tests/web-http-server.test.ts` suites, all of which re-pass unchanged), but is honestly disposed as **FIXED (not independently live-socket-verified for this one file)** rather than claimed as fully proven.

## Hard Non-Scope

No modification to `request-handler.ts` or any other file. No new runtime dependency. No route/behavior change for any ordinary header.

## Evidence

- `npx tsc -p tsconfig.json` (clean `dist/` rebuild): exit 0, zero errors.
- `node --test dist/tests/*.test.js`: **2665/2665 passing** (2664 pre-existing on this `main` tip + 1 new).
- Targeted re-run of `tests/cloudflare-worker-fetch-adapter.test.ts`, `tests/http-server.test.ts`, `tests/web-http-server.test.ts`: all pass unchanged (plus the new W4).
- Files touched: `src/web/http-server.ts`, `src/runtime/cloudflare-worker-fetch-adapter.ts`, `tests/cloudflare-worker-fetch-adapter.test.ts`, this exec-plan, `docs/engineering/CURRENT_STATE.md`.

## Status

**IMPLEMENTED / SELF-VALIDATED** — pending Brain/Founder independent review per `AGENTS.md` §10. `MERGE_DISPOSITION: HOLD_MERGE`. Risk classification: LOW — a two-line defensive hardening fix with no behavior change for any ordinary input, no IAM/authority/payment/provider coupling.
