# 0001 — V2-APP-001 web-application shell: framework and placement

## Status

Accepted (2026-08-26)

## Context

V2-APP-001 (DEC-158) requires the first logged-in application shell/HTTP boundary this repository has ever had. The task head's `PRE-EXECUTION REPOSITORY PREFLIGHT` step 4 delegates the exact open-source web framework and package/directory placement to Claude, subject to: TypeScript-compatible, mainstream/maintainable, minimally dependent, container/self-host portable (DEC-111), provider-neutral, testable/accessibility-capable, must not create a second domain lifecycle, and must not create a provider-proprietary deployment contract.

Live repo preflight (this checkpoint) confirmed: `package.json` declares zero runtime dependencies and exactly two devDependencies (`@types/node`, `typescript`); `src/` has only `domain/`, `fixtures/`, `application/`, `ports/`; no HTTP framework, frontend framework, ORM, or auth/session library exists anywhere in the dependency tree or source tree (this is the same finding V2-CDO-006's edge-stop and this task's own predecessor evidence already recorded).

## Decision

Build the shell directly on Node.js's built-in `node:http` module, with a small hand-written, transport-agnostic request-routing/dispatch layer in `src/web/`. No third-party web framework (Express, Fastify, Hono, Next.js, etc.) is introduced.

Concretely: all request-handling logic is implemented as a pure function `createRequestHandler(deps) => (req: IncomingRequestLike) => OutgoingResponseLike` with no dependency on `node:http` types at all; a thin adapter (`createHttpServer`) is the only file that touches `node:http`, translating a real `http.IncomingMessage`/`http.ServerResponse` pair to/from the plain request/response shapes the pure handler uses. This keeps almost the entire shell unit-testable without opening a socket, and the one genuine integration test uses Node's built-in `fetch` (available since Node 18, already the runtime here) against an ephemeral `server.listen(0)` port — no test-only HTTP client dependency either.

## Consequences

- Dependency delta for this task is **zero new runtime dependencies** — the strongest possible answer to the task's own A14 acceptance criterion ("Dependency delta is explicit and justified") and consistent with this repository's existing zero-runtime-dependency convention across every prior task (AKI-BE-001 through V2-CDO-005).
- Container/self-host portability is maximal: `node:http` has no cloud/PaaS-specific behavior, no proprietary deployment contract, and runs identically in any Node 18+ runtime (local, container, VM, or serverless-with-Node-compat).
- Provider neutrality is structural: there is no framework-specific session/auth/middleware convention to route around or accidentally leak canonical identity through — `SessionContext`/`TenantContext`/`AuthenticatedPrincipal` (`src/web/session-context.ts`) are this repository's own explicit types, not a framework's request-augmentation pattern.
- Trade-off accepted: no built-in templating engine, no automatic body-parsing/cookie middleware, no framework-provided routing DSL. Given the bounded scope (one example protected route, server-rendered semantic HTML, GET-only, no forms/mutations), this cost is small and is explicitly re-evaluated if/when V2-CDO-006 or a later task needs materially more routes, content negotiation, or view complexity than a hand-rolled dispatcher can reasonably support — at that point a mainstream, TypeScript-first, portable framework (e.g. a minimal one without a proprietary hosting requirement) would be the natural upgrade, introduced under its own authorized task rather than smuggled into this bootstrap.
- Rendering is server-rendered plain HTML strings (no client-side JavaScript framework). This satisfies the accessibility/responsive shell primitives required by this task (semantic landmarks, skip link, focus-visible styling, no color-only status, responsive viewport) without introducing a frontend framework dependency; V2-CDO-006 can extend or replace the rendering layer without touching the routing/session/tenant boundary this task establishes.

## Alternatives considered

- **Express**: most mainstream, but pulls in a moderate transitive dependency tree and its own middleware conventions the task explicitly warns against treating as "canonical customer/project identity authority" (Architecture Invariant #6/A6). Rejected for this bounded bootstrap; not ruled out for a later, larger task.
- **Fastify**: modern, fast, decent TypeScript support, but still a real dependency tree and a plugin/decorator model that would need the same care Express does to keep session/tenant context explicit rather than framework-owned.
- **Hono**: very small footprint and TypeScript-native, portable across runtimes, but for a Node self-host it still requires an adapter package (`@hono/node-server`) and introduces a routing DSL this bounded task does not need yet.
- **Next.js or another full frontend framework**: far exceeds "minimum bootstrap" scope, brings a build pipeline and (for several deployment patterns) provider-specific hosting assumptions the task explicitly forbids hard-coding.
