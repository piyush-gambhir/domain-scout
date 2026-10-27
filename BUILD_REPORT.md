# Domain Scout build report

Built October 5 to 7, 2026 on the `build` branch, pushed to the private GitHub repository on October 7. On October 27 the stack moved to Node 26 with every dependency at its latest compatible release, and the two small UI gaps from the pending list were closed; the suites below were rerun then. This report separates what was built, how it was verified, and what is still pending. Live checks used only the authorized fixed test set: `example.com`, `google.com`, `nic.si`, `bbc.co.uk` and random 24-character gibberish names.

## Status

The full product scope in [PRODUCT.md](PRODUCT.md) is implemented across the backend, web UI and Go CLI, and runs locally with `docker compose up --build`, `pnpm dev`, or the packaged archives. Of the 80 numbered requirements, the last independent requirement audit (gpt-6.1-sol) found 68 implemented and tested, 7 implemented without a dedicated test and 5 partial, none missing. Since then the 1,000-domain acceptance run (B08), live WHOIS validation (A02), the MCP adapter (G01), comparison ordering (R08), CLI machine output for cancelled runs (G04) and quote decision fields (G08) gained tests or live runs, and W02, H02 and X05 were fixed. What is still open is listed under [Pending work](#pending-work).

After the first full build Piyush asked for a redesign, because the first UI mirrored backend modules instead of tasks. It was rebuilt around tasks instead of backend modules, following [docs/UX_PLAN.md](docs/UX_PLAN.md): Search, Saved, Watching, History and Settings replace nine module pages; small searches show a name by extension grid and long lists a grouped list; free names say "Not registered", never "Available"; every row has Save, Buy and Watch; evidence internals sit one click away. Pages fit the window at 1440x900 and 1280x800, and only data regions scroll.

## What was built

| Area | Contents |
| --- | --- |
| Contracts | `packages/contracts`: Zod schemas and one route table for 95 operations, generating the OpenAPI 3.0 document, the TypeScript client and the Go client |
| Backend | NestJS 12 on `node:sqlite`: local runtime (data directory, lock, owner-only token, runtime file), local auth (token, single-use browser bootstrap, sessions, CSRF, Origin and Host checks), SSE with replay, durable jobs engine with shared per-source budgets, cooldowns, retries, cancel/resume/retry and idempotency, registry routing and classification, nine provider adapters plus the .si registry directory, pricing and comparisons, shortlists and saved criteria, local candidate generation, monitoring with notices, name checks and DNS/TLS/HTTP diagnostics, scoped exports and self-contained snapshots, scoped data deletion |
| Registry coverage | IANA RDAP bootstrap plus curated routes: 56 suffixes tested, 1,198 discovered, 192 unsupported (each with a reason). Curated RDAP for .ch, .li and .co; registry-specific WHOIS classifiers for 45 suffixes (.de, .io, .jp, .cn, .eu, 36 more ccTLDs and 4 .za zones) |
| Web UI | Next.js 16, task-based: Search (one input with remembered extensions, live grid or grouped list, Ideas mode, row actions Save, Buy, Watch), Saved (shortlists with multi-year cost by provider, quotes, Buy), Watching (watches with the current state of their names, and an inbox of changes), History (UI and agent runs by origin), Settings (providers, preferences, checks, coverage, data, service); docked domain panel that leads with status, best prices and where to buy |
| CLI | Go `domain-scout`: every API operation, JSON/table/NDJSON output, SSE waits with replay and polling fallback, the handoff's exit codes, a launcher that starts or reuses the backend and web server, `ui --job` to open a run in the UI, `prices published` for catalog prices per extension, and `domain-scout mcp` (11 MCP tools over stdio on the same API) |
| Runs | `docker compose up --build` (single container, UI on host loopback only), `pnpm dev`, `pnpm smoke`, `pnpm acceptance` (1,200 names against a local stub registry), `pnpm package` (archives for macOS arm64/amd64, Linux amd64/arm64, Windows amd64) |

Build-time technology decisions are recorded in [TECH_STACK.md](TECH_STACK.md#build-time-decisions); conventions and module ownership in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Verification

### Automated suites (all passing at the last full run)

| Suite | Result |
| --- | --- |
| Backend (Vitest, real temporary SQLite, fake transports) | 827 tests in 52 files |
| Contracts and API client (Vitest) | 6 and 5 tests |
| Go CLI (`go test`) | 4 packages, all passing, including the MCP server, cancelled-run output and quote decision fields; one earlier unexplained failure under heavy parallel load did not reproduce in 13 reruns |
| Web (Playwright against the real backend, fixtures only where a test would reach the network) | 154 tests: 76 for the five journeys, redirects, keyboard use, settings, providers and sessions, and 78 layout checks (no page scroll at 1440x900 and 1280x800, no sideways scroll at 390x844) |
| Typecheck and lint (`pnpm turbo run typecheck lint`) | Clean |
| `pnpm smoke` (CLI, API and web on one backend, live fixed set) | 14 of 14 checks |
| `pnpm acceptance` (1,200 names twice through the CLI and backend, local stub registry) | 11 of 11 checks: cancel at 30% and resume, backend stop and restart, no finished name queried twice, TXT export exact; 2.9 s per job, result pages p95 7 ms while jobs run (Node 26) |
| MCP over stdio against a real backend | initialize, 11 tools listed, `scan` of example.com returned `registered` through the registry only |

### Live checks (fixed test set only)

| Check | Destination | Result |
| --- | --- | --- |
| `example.com`, `google.com` | rdap.verisign.com | registered |
| gibberish `.com` | rdap.verisign.com | no_record |
| `nic.si`, gibberish `.si` | rdap.register.si | registered, no_record |
| `bbc.co.uk`, gibberish `.co.uk` and `.uk` | rdap.nominet.uk | registered, no_record |
| gibberish `.dev` | pubapi.registry.google | no_record |
| gibberish `.ch`, `.li`, `.co` | rdap.nic.ch, rdap.nic.li, rdap.registry.co | no_record |
| gibberish names on every curated WHOIS route (45 registries, including .de, .io, .jp, .cn, .eu and the .za zones) | the registries' WHOIS servers on port 43 | 43 no_record as expected; `.il` inconclusive (disclaimer only), `.pt` timed out |
| Porkbun public catalog | api.porkbun.com pricing (no names sent) | 911 TLD prices |
| DNS, nameservers, DNSSEC, TLS, HTTP for `example.com`, `google.com` | system resolver, Cloudflare DoH, the domains' own servers | observed |
| GitHub, npm, PyPI, crates.io name checks | the services' public APIs | exists / not_found as expected |

Recorded in `apps/backend/data/registry/live-validation.json` (56 checks across 52 suffixes, 55 as expected). Port 43 was blocked during the first build and opened on October 6, which is when the WHOIS routes were validated. One deviation: an early live name-check spec used `react`, `requests`, `github` and `serde` (outside the fixed set) against npm, PyPI, GitHub and crates.io twice before it was corrected to fixed-set names. Separately, at Piyush's explicit request on October 7, 562 candidate `.si` names (super intelligence and science fiction themes) were checked against rdap.register.si only; no registrar or aggregator received them.

### Platform runs

| Platform | What ran |
| --- | --- |
| macOS arm64 | Source build, `pnpm dev`, `pnpm smoke`, packaged archive extracted and run end to end (rerun on Node 26.12.1 on October 27) |
| macOS amd64 | Packaged CLI under Rosetta (`version`) |
| Linux arm64 and amd64 | Packaged archives run in `node:26` containers (`scripts/verify-linux-package.sh`, rerun October 27): launcher, browser sign-in, API through the web server, owner-only permissions (700/600), clean stop |
| Docker | `docker compose up --build` from a fresh volume: sign-in link, all pages, live scan through the web API, CLI inside the container, restart keeps sessions and jobs. On October 27 the Node 26 image was rebuilt and a fresh container reached healthy, served the UI and answered the CLI |
| Windows amd64 | Cross-compiled and packaged only; not run |

### Reviews

Every major change was reviewed by gpt-6.1-sol, and findings were confirmed against the code before fixing. An integrated backend audit found 15 issues (two privacy-related: provider responses echoing credentials into stored evidence, and deleted evidence surviving in replayable events); all were fixed with regression tests. The task-based UI went through three review rounds (fixed: an open redirect in the sign-in `next` path, prices compared across currencies or terms, expired or disabled-provider quotes being recommended, a race creating two default lists). A final review of the MCP adapter, history counts and the last UI fixes found three issues (Recheck all skipping unloaded rows, concurrent MCP shortlist creation, incomplete local MCP error envelopes), all fixed with regression tests.

## Requirement coverage

The second requirement audit (gpt-6.1-sol) is the last independent count. The right column records what changed after it; it is our own reclassification, not a fresh audit.

| Status | At the audit | Since |
| --- | --- | --- |
| Implemented and tested | 68 | B08 (`pnpm acceptance`), R08 (comparison ordering spec), G01 (MCP adapter and its tests), G04 and G08 (CLI machine-output tests) gained dedicated tests |
| Implemented, no dedicated test | 7 (B08, R08, P07, G01, G04, G08, D04) | P07 (live quotes need provider keys) and D04 (no single parity test across UI, CLI and MCP for diagnostics) remain |
| Partial | 5 (R05, F05, W02, H02, X05) | W02, H02 and X05 fixed with regression tests (comparable price terms for watches and history, restrictions in history series, source and reason in the CSV checks column); R05 and F05 remain (item 2 below) |

## Pending work

These need access, authorization or machines this build did not have.

1. **Authenticated provider operations (P07, R09, scenario 6).** All nine adapters implement their documented exact checks, quotes, transfers and aftermarket calls and are tested against documentation-derived fixtures. None has run against a real account. Needed: API keys for the providers you use, then a recorded live quote per provider (fixed test names only).
2. **Purchase handoff for renewal and transfer, and storefront verification (R05, F05).** New-registration links exist for every provider but were never opened, and no provider manifest has renewal or transfer destinations, so those paths show no link. Needed: authorization to open provider storefronts with fixed test names, then recorded templates with verification dates.
3. **Two WHOIS registries without a live pass.** `.il` answers a gibberish name with only its disclaimer and no "not found" line, so it stays `inconclusive` instead of guessing `no_record`; telling not-found from throttling needs a registered `.il` name, which is outside the fixed test set. `.pt` (whois.dns.pt) timed out on both attempts.
4. **Windows (scenario 19).** The Windows archive builds; owner-only ACLs (`icacls`), process detach, signal handling and the browser opener were never run on Windows. Needed: a Windows machine.
5. **Not implemented provider extras.** GoDaddy locked registration quotes and Auctions, Sedo and Atom marketplace integrations (Atom's anonymous search is documented but outside the authorized live set).
6. **Live IDN validation.** IDN normalization is unit-tested; no internationalized name is in the fixed live set.
7. **A live 1,000-name run against a public registry.** The acceptance run measures the full engine, CLI and API against a local stub registry; stress runs against public registries are not authorized.

## Verification limits

- Fixture-tested is not live-tested: provider adapters and WHOIS classifiers follow official documentation and reference captures, and their fixtures record provenance.
- Coverage counts are routing facts, not proof that every discovered registry answers correctly; only "tested" suffixes have fixtures or live checks.
- "No record" is a registry fact at check time, never a promise that a name can be registered or at what price.
