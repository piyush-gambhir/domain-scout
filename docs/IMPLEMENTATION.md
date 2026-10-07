# Implementation guide

Engineering conventions for building Domain Scout. Product scope and semantics live in [PRODUCT.md](../PRODUCT.md) and [BUILD_HANDOFF.md](../BUILD_HANDOFF.md); this file records how the code is organized and the contracts between parts. Started October 5, 2026.

## Monorepo

Turborepo 2 with pnpm 11 workspaces. Node 24.11 or newer. TypeScript 5.9 everywhere (TypeScript 7 lacks the compiler API that Next, ESLint and test tooling use).

| Path | Package | What it is |
| --- | --- | --- |
| `packages/contracts` | `@domain-scout/contracts` | Zod schemas for every public object, the route table (`routes.ts`) and the OpenAPI 3.0 emitter. `openapi.json` is generated and committed. |
| `packages/api-client` | `@domain-scout/api-client` | Typed fetch client driven by the route table. |
| `apps/backend` | `@domain-scout/backend` | NestJS 12 (ESM) on Express, `node:sqlite`, jobs, adapters, everything stateful. |
| `apps/web` | `@domain-scout/web` | Next.js 16 App Router UI. Forwards `/api/v1/*` to the backend. Owns no state or external calls. |
| `apps/cli` | `@domain-scout/cli` | Go module (`domain-scout` executable). `package.json` wraps `go` so Turbo runs it. |
| `scripts/` | | `dev.mjs` (local dev launcher), `package.mjs` (distribution). |

Turbo tasks: `generate` (OpenAPI then Go client), `build`, `typecheck`, `lint`, `test`, `test:e2e`, `dev`. Run `pnpm turbo run <task> --filter <pkg>` for one package.

Rules for everyone:

- ESM everywhere. Relative TypeScript imports in backend and packages end in `.js`.
- Do not run `pnpm install` or add dependencies without the lead's approval; parallel installs corrupt the lockfile. Everything planned is already installed. If you need something else, say so in your report.
- `packages/contracts` is the source of truth for the API. Only the lead edits it during parallel work. If you need a contract change, describe it precisely in your report; never fork a private copy of a public shape.
- No em dashes anywhere (prose, comments, UI copy, commits). Use a colon, comma, parentheses or two sentences.
- Comments are brief and say why. No taglines, slogans or instructional filler in the UI.
- Tests: focused tests for behavior. Fixtures carry provenance (where the sample came from, date, whether it is a documentation-derived reconstruction or a captured live response).

## Semantics that must never break

- A missing registry record is `no_record`, never "available". Timeouts, rate limits, blocks, malformed or empty data and unknown extensions are unresolved outcomes. DNS absence is never an availability signal.
- Registry evidence, provider confirmation, offers, name checks and diagnostics are separate evidence kinds with their own source, time and freshness. None overwrites another.
- Money is a decimal string. Unknown is `null`, never zero. Rank only complete, comparable prices.
- Discovery sends names only to registry services. Provider checks, quotes, enrichment and diagnostics run only when explicitly requested and record their destinations.
- Secrets never appear in API responses, logs, exports, snapshots or SQLite.

## Live network rule

Development and tests may send only this fixed set to the network: `example.com`, `google.com`, `nic.si`, `bbc.co.uk` and random 24-character gibberish labels (for example under `.com`, `.si`, `.uk`, `.de`, `.io`, `.dev`). Allowed destinations: registry RDAP/WHOIS servers, IANA bootstrap and WHOIS referral metadata, Porkbun's keyless pricing endpoint, and the optional DNS, TLS, HTTP, GitHub, npm, PyPI and crates.io checks. Never call a registrar API, aggregator or storefront. Live tests live under `apps/backend/test/live/` and run only with `DOMAIN_SCOUT_LIVE_TESTS=1`.

## Backend architecture

`src/app.factory.ts` builds the app (shared by `main.ts` and tests). `AppModule.forRoot({ config, clock })` wires every module. `CoreModule` is global and provides `APP_CONFIG`, `Clock`, `Database`, `EvidenceRepository`, `SettingsService`, `EventsService` and `OperationRegistry`.

| Module | Directory | Owns |
| --- | --- | --- |
| Core / storage | `core/`, `storage/` | Config, clock, errors, route binding, envelope, ports, SQLite wrapper and migrations, evidence repository |
| Runtime | `runtime/` | Data/runtime directories, instance lock, runtime file, API token, bootstrap codes, sessions, auth guard (token, session, origin, CSRF, host), graceful stop |
| System | `system/` | Health, capabilities, settings, service stop, history, data inventory and scoped deletion |
| Events | `events/` | Event log, SSE endpoint with replay, heartbeat, reset, compaction |
| Jobs | `jobs/` | Job planning, persistence, scheduler with shared source budgets, cooldowns, retries, cancel/resume/retry/recheck, idempotency, results query with the shared ResultFilter |
| Registry | `registry/` | Input normalization (`InputPreviewer`), suffix rules, IANA bootstrap, WHOIS routing and parsers, RDAP client and classifier, `registry` handler, coverage |
| Providers | `providers/` | Nine provider adapters and regional directories, manifests, credentials store and console API, catalogs, `provider_check`, `quote`, `transfer`, `aftermarket`, `catalog` handlers |
| Pricing | `pricing/` | Decimal math, offers queries, best prices, comparisons, price history, transfer options, portfolio |
| Collections | `collections/` | Shortlists, entries, notes, saved criteria, extension presets |
| Discovery | `discovery/` | Local candidate generation and themes |
| Monitoring | `monitoring/` | Watches, scheduling, missed runs, catch-up, notices |
| Enrichment | `enrichment/` | Name checks and diagnostics handlers |
| Exports | `exports/` | TXT/CSV/JSON exports and HTML/JSON snapshots with explicit scopes |
| Evidence | `evidence/` | `GET /domains/:name/evidence` aggregation and raw diagnostics |

Modules talk through injected services and the ports in `core/ports.ts`, never through HTTP. Cross-module reads may query the shared SQLite schema directly (`storage/migrations.ts`); writes go through the owning module or `EvidenceRepository`.

### Controllers

Every route is declared once in `packages/contracts/src/routes.ts`. Controllers are `@Controller()` (no prefix) and bind handlers with `@ApiRoute('operationId')`; `@ApiInput()` returns `{ params, query, body }` validated against that operation's schemas. Return `ok(data)` or `paged(items, nextCursor, total)` from `core/envelope.ts`. Throw `AppError` (`core/errors.ts`) for failures; the global filter produces the `ErrorResponse` contract. HTTP 400 invalid request, 401 local auth, 404 absent resource, 409 conflicting state or idempotency reuse, 503 local execution unavailable. Source failures are per-item evidence, not request failures.

### Jobs engine and handlers

The engine (`jobs/`) owns scheduling, budgets, persistence and events. External work is done by `OperationHandler`s (`jobs/operation.ts`) that modules register with `OperationRegistry.register()` in `onModuleInit`.

- `sourceKey(item)` returns the shared budget key: `registry:<registryId>` (RDAP and WHOIS for one registry share it), `provider:<id>`, `service:<id>`, `resolver:<id>`, `host:<domain>` for TLS/HTTP diagnostics, or null for local work.
- `execute(item, ctx)` performs one item and returns `OperationResult`: outcome, resolved flag, evidence rows to write, optional cooldown (`cooldownUntil`), retryability and `retryAt`. Handlers do not write job state. The engine writes evidence, the item, job counters and events in one transaction.
- Defaults (settings): 16 global in flight, 1 per source, 1000 ms between request starts per source, up to 3 attempts for transient failures with exponential backoff and jitter, Retry-After honored and shared through `source_cooldowns`. A cooldown longer than `maxCooldownWaitSeconds` finishes the item unresolved with `retryAt`.
- Job states: queued, running, cancelling, cancelled, completed, completed_with_errors, interrupted. Item states: pending, running, finished, interrupted. On startup, running work becomes interrupted. Resume is explicit.
- Planning per job type: `registry_scan` uses `InputPreviewer.preview()`; provider operations expand domains by providers; name checks expand names by services; diagnostics expand domains by checks; `watch` and `catalog_refresh` use the internal requests in `core/ports.ts`.
- Idempotency: `Idempotency-Key` plus a fingerprint of operation and body. Same key and body returns the original job; a different body returns 409.

### Events

`EventsService.emit(type, { jobId, watchId }, payload)` must be called inside the same `Database.transaction` as the state change. SSE (`GET /api/v1/events`) replays from `Last-Event-ID` (or `?after=`), filters by job/watch/types, sends heartbeats, and sends `stream.reset` when the cursor is older than retained events. Transient progress events are compacted after 24 hours.

### Evidence storage

`observations` holds every evidence kind except prices (`kind` registry, confirmation, name_check, diagnostic, listing) with `payload_json` set to the contract object minus computed fields. `offers` holds catalog and quote prices. Read helpers `hydrateObservation` and `hydrateOffer` compute freshness at read time. Registry evidence is stale after 15 minutes, catalogs after 24 hours, quotes after 15 minutes or the provider expiry. `best_prices` is a derived table maintained by pricing.

### Testing

Vitest with SWC (decorator metadata). `test/helpers.ts#createTestApp()` boots the full app on a temporary data directory with a `FakeClock`. Inject transports through Nest providers (`overrideProvider`) so no test touches the network. Use real temporary SQLite databases for migrations and recovery.

## Local runtime protocol

Shared by backend, Go CLI and web; keep them identical.

- Data directory: `--data-dir`, else `DOMAIN_SCOUT_DATA_DIR`, else macOS `~/Library/Application Support/Domain Scout`, Windows `%LOCALAPPDATA%\Domain Scout`, Linux `$XDG_DATA_HOME/domain-scout` or `~/.local/share/domain-scout`.
- Runtime directory: `<dataDir>/run` (mode 0700). Files: `backend.json` (url, pid, instanceId, protocolVersion, contractVersion, version, startedAt, dataDir), `api-token` (0600, random 32 bytes base64url), `web.json` (url, pid) when the UI server runs. Lock: `<dataDir>/backend.lock` (pid, instanceId); stale locks from dead processes are replaced.
- Backend flags: `--data-dir`, `--host` (default 127.0.0.1), `--port` (default 4317), `--web-origin` (repeatable, default `http://127.0.0.1:3000` and `http://localhost:3000`). Env `DOMAIN_SCOUT_PORT` also sets the port. Port in use: exit with a clear error, never attach to another service.
- Clients verify identity by reading `backend.json`, calling `GET /api/v1/health` and checking `instanceId` and `protocolVersion` before reuse.
- Auth: `Authorization: Bearer <api-token>` (CLI, launcher, Next server), or the browser session cookie `ds_session` with `X-CSRF-Token` (matching the session's token, readable from the `ds_csrf` cookie) on mutating methods, and an `Origin` in the allowed web origins when present. Requests with a `Host` other than the loopback host and port are rejected (DNS rebinding). `GET /health` and `POST /auth/session` need no auth.
- Browser bootstrap: the launcher calls `POST /api/v1/auth/bootstrap-codes` with the token (single use, 60 seconds) and opens `http://127.0.0.1:3000/auth/bootstrap?code=...`. The Next route exchanges it through `POST /api/v1/auth/session`, sets `ds_session` (HttpOnly, SameSite=Strict) and `ds_csrf` (SameSite=Strict, readable), then redirects to `/` (Search), or to a same-origin `next` path such as `/search/<job-id>` from `domain-scout ui --job`, so the code leaves the URL. Sessions last 7 days, are stored hashed, and survive backend restarts.
- Next forwards `/api/v1/*` to `DOMAIN_SCOUT_BACKEND_URL` (default `http://127.0.0.1:4317`) with cookies, CSRF, idempotency and Last-Event-ID headers, streaming responses (SSE) without buffering. The API token never reaches browser JavaScript.
- Stop: `POST /api/v1/service/stop` halts dispatch, aborts in-flight calls within a bounded grace period, marks unfinished items interrupted, checkpoints SQLite, removes the runtime file and lock, and exits.

## Go CLI contract

See BUILD_HANDOFF.md "Go command contract". JSON by default (the API envelope with `contractVersion`), `--output table|ndjson`, stdout for data only, stderr for progress and errors, `--no-input` accepted everywhere. Exit codes: 0 success or accepted submission, 1 local failure, 2 invalid usage or request, 3 completed with unresolved items, 4 provider access missing, 5 backend setup or version failure, 130 interrupted wait.
