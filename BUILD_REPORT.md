# Domain Scout build report

Built October 5, 2026 on the local `build` branch (not pushed). This report separates what was built, how it was verified, and what is still pending. Live checks used only the authorized fixed test set: `example.com`, `google.com`, `nic.si`, `bbc.co.uk` and random 24-character gibberish names.

## Status

The full product scope in [PRODUCT.md](PRODUCT.md) is implemented across the backend, web UI and Go CLI, and runs locally with `docker compose up --build`, `pnpm dev`, or the packaged archives. Of the 80 numbered requirements, an independent requirement audit (gpt-6.1-sol, re-run after the final fixes) found 68 implemented and tested, 7 implemented but without a dedicated test, and 5 partial, with none missing. The partial and pending items are listed under [Pending work](#pending-work). Authenticated provider operations, WHOIS lookups and Windows were not verified live; see [Verification limits](#verification-limits).

A UI/UX rework (workspace layout with a docked detail panel, compact density, no page scrolling at desktop sizes) was requested after the first full build and is in progress; this report will be updated when it lands.

## What was built

| Area | Contents |
| --- | --- |
| Contracts | `packages/contracts`: Zod schemas and one route table for 94 operations, generating the OpenAPI 3.0 document, the TypeScript client and the Go client |
| Backend | NestJS 12 on `node:sqlite`: local runtime (data directory, lock, owner-only token, runtime file), local auth (token, single-use browser bootstrap, sessions, CSRF, Origin and Host checks), SSE with replay, durable jobs engine with shared per-source budgets, cooldowns, retries, cancel/resume/retry and idempotency, registry routing and classification, nine provider adapters plus the .si registry directory, pricing and comparisons, shortlists and saved criteria, local candidate generation, monitoring with notices, name checks and DNS/TLS/HTTP diagnostics, scoped exports and self-contained snapshots, scoped data deletion |
| Registry coverage | IANA RDAP bootstrap plus curated routes: 53 suffixes tested, 1,201 discovered, 192 unsupported (each with a reason). Curated RDAP for .ch, .li and .co; registry-specific WHOIS classifiers for 45 suffixes (.de, .io, .jp, .cn, .eu, 36 more ccTLDs and 4 .za zones) |
| Web UI | Next.js 16: scan with live preview, jobs with a virtualized results table and bulk actions, domain details, shortlists, discover, monitoring, history with price charts, compare (registration, transfer, aftermarket, portfolio), providers console, settings, data controls |
| CLI | Go `domain-scout`: every API operation, JSON/table/NDJSON output, SSE waits with replay and polling fallback, the handoff's exit codes, a launcher that starts or reuses the backend and web server |
| Runs | `docker compose up --build` (single container, UI on host loopback only), `pnpm dev`, `pnpm smoke`, `pnpm package` (archives for macOS arm64/amd64, Linux amd64/arm64, Windows amd64) |

Build-time technology decisions are recorded in [TECH_STACK.md](TECH_STACK.md#build-time-decisions); conventions and module ownership in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

## Verification

### Automated suites (all passing at the last full run)

| Suite | Result |
| --- | --- |
| Backend (Vitest, real temporary SQLite, fake transports) | 820 tests in 49 files |
| Contracts and API client (Vitest) | 6 and 5 tests |
| Go CLI (`go test`, including `-race`) | 4 packages, all passing; one unexplained failure under heavy parallel load did not reproduce in 13 reruns |
| Web (Playwright against the real backend, fixtures only where a test would reach the network) | 62 specs |
| Typecheck and lint (`pnpm turbo run typecheck lint`) | Clean |
| `pnpm smoke` (CLI, API and web on one backend, live fixed set) | 14 of 14 checks |

### Live checks (fixed test set only)

| Check | Destination | Result |
| --- | --- | --- |
| `example.com`, `google.com` | rdap.verisign.com | registered |
| gibberish `.com` | rdap.verisign.com | no_record |
| `nic.si`, gibberish `.si` | rdap.register.si | registered, no_record |
| `bbc.co.uk`, gibberish `.co.uk` and `.uk` | rdap.nominet.uk | registered, no_record |
| gibberish `.dev` | pubapi.registry.google | no_record |
| gibberish `.ch`, `.li`, `.co` | rdap.nic.ch, rdap.nic.li, rdap.registry.co | no_record |
| Porkbun public catalog | api.porkbun.com pricing (no names sent) | 911 TLD prices |
| DNS, nameservers, DNSSEC, TLS, HTTP for `example.com`, `google.com` | system resolver, Cloudflare DoH, the domains' own servers | observed |
| GitHub, npm, PyPI, crates.io name checks | the services' public APIs | exists / not_found as expected |

Recorded in `apps/backend/data/registry/live-validation.json`. One deviation: an early live name-check spec used `react`, `requests`, `github` and `serde` (outside the fixed set) against npm, PyPI, GitHub and crates.io twice before it was corrected to fixed-set names.

### Platform runs

| Platform | What ran |
| --- | --- |
| macOS arm64 | Source build, `pnpm dev`, `pnpm smoke`, packaged archive extracted and run end to end |
| macOS amd64 | Packaged CLI under Rosetta (`version`) |
| Linux arm64 and amd64 | Packaged archives run in `node:24` containers (`scripts/verify-linux-package.sh`): launcher, browser sign-in, API through the web server, owner-only permissions (700/600), clean stop |
| Docker | `docker compose up --build` from a fresh volume: sign-in link, all pages, live scan through the web API, CLI inside the container, restart keeps sessions and jobs |
| Windows amd64 | Cross-compiled and packaged only; not run |

### Reviews

Every major change was reviewed by gpt-6.1-sol, and findings were confirmed against the code before fixing. An integrated backend audit found 15 issues (two privacy-related: provider responses echoing credentials into stored evidence, and deleted evidence surviving in replayable events); all were fixed with regression tests.

## Requirement coverage

From the second requirement audit (after the final fixes):

| Status | Count |
| --- | --- |
| Implemented and tested | 68 |
| Implemented, no dedicated test | 7 (B08, R08, P07, G01, G04, G08, D04) |
| Partial | 5 (R05, F05, W02, H02, X05) |

W02, H02 and X05 were fixed after that audit (comparable price terms for watches and history, restrictions in history series, source and reason in the CSV checks column). The remaining partial items are below.

## Pending work

These are larger pieces that need access, authorization or machines this build did not have, or that were optional in the plan.

1. **Authenticated provider operations (P07, R09, scenario 6).** All nine adapters implement their documented exact checks, quotes, transfers and aftermarket calls and are tested against documentation-derived fixtures. None has run against a real account. Needed: API keys for the providers you use, then a recorded live quote per provider (fixed test names only).
2. **WHOIS live validation (A02, scenario 4).** 45 suffixes use WHOIS (.de, .io, .jp, .cn, .eu, 36 more ccTLDs and 4 .za zones). Outbound TCP 43 was blocked on the development network, so those classifiers are fixture-tested only. Needed: a network with port 43 open, then `DOMAIN_SCOUT_LIVE_TESTS=1 pnpm --filter @domain-scout/backend test:live` with the fixed test set.
3. **Purchase handoff for renewal and transfer, and storefront verification (R05, F05).** New-registration links exist for every provider but were never opened, and no provider manifest has renewal or transfer destinations, so those paths show no link. Needed: authorization to open provider storefronts with fixed test names, then recorded templates with verification dates.
4. **1,000-domain acceptance run (B08, scenarios 2 and 18).** The engine processes 1,000 items in about 0.3 seconds with fake handlers and the UI virtualizes 1,500 rows, but no measured run of a live 1,000-domain batch with cancellation and resume through the UI and CLI was done, because public registry stress runs are not authorized by default. Needed: authorization, or a deterministic local registry stub for a full end-to-end measurement.
5. **Windows (scenario 19).** The Windows archive builds; owner-only ACLs (`icacls`), process detach, signal handling and the browser opener were never run on Windows. Needed: a Windows machine.
6. **MCP adapter (G01, optional in the plan).** Not built. It would be a thin stdio adapter over the existing API.
7. **Not implemented provider extras.** GoDaddy locked registration quotes and Auctions, Sedo and Atom marketplace integrations (Atom's anonymous search is documented but outside the authorized live set).
8. **Live IDN validation.** IDN normalization is unit-tested; no internationalized name is in the fixed live set.
9. **UI/CLI parity tests (G01, D04, G08).** Parity is exercised by `pnpm smoke` for scans, evidence, exports and restarts; there is no dedicated parity test for diagnostics, quotes and every workflow.

## Verification limits

- Fixture-tested is not live-tested: provider adapters and WHOIS classifiers follow official documentation and reference captures, and their fixtures record provenance.
- Coverage counts are routing facts, not proof that every discovered registry answers correctly; only "tested" suffixes have fixtures or live checks.
- "No record" is a registry fact at check time, never a promise that a name can be registered or at what price.
