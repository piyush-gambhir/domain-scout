# Domain Scout build handoff

Updated October 5, 2026. Engineering plan for the agent Piyush will instruct to build. **Go CLI, NestJS backend and Next.js frontend are user-selected.** This turn finalizes documentation; it does not authorize application code, dependencies, commits, pushes or publication.

Read [PRODUCT.md](PRODUCT.md) for the full scope and 19 acceptance scenarios, [TECH_STACK.md](TECH_STACK.md) for technology choices, and [REFERENCES.md](REFERENCES.md) and [SOURCE_REVIEW.md](SOURCE_REVIEW.md) for integration evidence. This handoff adds implementation contracts without shrinking scope, estimating effort or dividing features into phases.

## Decisions and open answers

| Decision | Status |
| --- | --- |
| Own product, full feature scope and complete UI redesign | User-selected; requirements in PRODUCT.md |
| Local app and private repository | User-selected; no hosted infrastructure required |
| Go CLI, NestJS API and Next.js frontend | User-selected |
| Next calls Nest | User-confirmed |
| Separate local Next and Nest servers | Engineering default interpreting that boundary; headless CLI needs only Nest |
| Express adapter | Revised recommendation based on simplicity, workload and existing Nest projects |
| SQLite, REST/OpenAPI, SSE, backend-owned jobs | Supporting engineering defaults below |
| Cobra | Supporting parser default; not a user mandate |
| MCP | Optional later adapter, not a completion prerequisite |
| Visual design | Explicitly excluded from this planning pass; retain functional UI requirements, no layout decision blocks this handoff |
| Packaged OS support | User-selected: macOS, Windows and Linux |
| Registrar account access | None available now; keyless capabilities work by default, optional key-based integrations configured in the application console/settings or CLI |

There are no remaining blocking product or stack questions. Missing registrar access does not block registry discovery, public information or fixture-based adapter work. It prevents claiming authenticated integrations were validated live. Exact package versions and compatible artifacts are implementation checks, not new product approval questions.

## Repository and module ownership

Planned paths, not existing application code:

```text
apps/backend/           Nest services, adapters, workers and migrations
apps/web/               Next App Router UI and API forwarding
packages/contracts/    Public Zod schemas and exported OpenAPI
packages/api-client/   TypeScript API client
cli/                   Go module, commands, generated client, SSE reader
data/                  Versioned registry and provider metadata
fixtures/              Sanitized source samples with provenance
scripts/               Local launch, generation and packaging commands
```

Nest owns normalization, registry classification, providers, prices, generation, jobs, watches, persistence and exports. Next owns human presentation. Go owns command parsing, input/output, startup and API calls. Optional MCP maps API operations to tools. No interface writes SQLite or implements another scanner.

Nest modules: Registry, Providers, Pricing, Jobs, Collections, Discovery, Monitoring, Enrichment, Exports, Storage and LocalRuntime. Use services and dependency injection, not microservices or controller-to-controller HTTP. Inject transports and clocks for deterministic tests without public queries.

## Local runtime and access

A launcher starts/connects to Nest, starts Next when UI is requested, and opens the browser. Go auto-starts installed Nest assets when needed. Jobs and configured watches continue with the browser closed. Closing Next does not stop Nest. Provide explicit service stop; do not install an always-on OS service by default.

Bind to loopback. Defaults: Next 127.0.0.1:3000, Nest 127.0.0.1:4317; allow configured ports. Use a per-data-directory instance lock and an owner-only runtime file containing actual endpoint, process identity, instance ID and protocol version. Verify identity/version before reuse, not just an answering port. Report port conflicts without connecting to another service.

Durable state belongs in the platform's per-user application-data directory, outside the repo. Separate transient runtime metadata. An explicit --data-dir override changes this application's path only.

Use an owner-readable random local API token for CLI authorization. A short-lived, single-use launcher exchange establishes an HttpOnly browser session, then removes bootstrap material from the URL. Nest validates session/origin and CSRF for mutations. Next forwards authenticated API/SSE requests without exposing the API token in browser JavaScript or routine logs. This is local access control, not public account registration.

Provide a Providers/Integrations console in the UI and equivalent CLI configuration. Each provider has its required key/token fields, setup link, save/test/disconnect controls and readiness state. Secret entry fields are masked and existing secrets are never returned by APIs. Test credentials with a documented non-candidate account operation where available; otherwise report that validation requires a separately requested domain check. Never probe an arbitrary candidate to test a key.

Secrets can be supplied by environment variables, kept for the running session, or explicitly saved to a separate owner-only local credential file. Implement restricted permissions/ACLs on all target platforms; keep this file outside SQLite and the repository. Saving locally is explicit, with the storage location/mode visible. No secrets in exports, snapshots, logs or generated clients. OS keychain convenience is not required. Account configuration never implicitly authorizes candidate submission.

Graceful stop halts dispatch, bounds abort/cleanup time, commits completed evidence and marks unfinished work interrupted. Restart retains evidence and source cooldowns. User jobs resume explicitly. Active watches restore their schedule, show missed intervals and perform at most one catch-up check per watch rather than replaying every missed interval.

## API and events

REST base: /api/v1. JSON: camelCase, UUID IDs, UTC RFC3339 timestamps, decimal money strings and explicit null for unknown fields. Responses expose contractVersion. Pagination uses opaque cursors. Errors expose code, message, requestId, affected domain/source, retryable and retryAt, without secrets or authenticated upstream URLs.

HTTP 400 means invalid request, 401 local auth failure, 404 absent local resource, 409 conflicting state, and 503 temporarily unavailable local execution. Source failures are normally per-item evidence in a job, preserving other results. Invalid rows in a valid preview are data, not a failed API request.

| API family | Operations |
| --- | --- |
| System | GET /health, /capabilities, /settings; PATCH /settings; authenticated POST /service/stop |
| Input | POST /inputs/preview: parsing, validation, expansion and deduplication, with no external queries |
| Jobs | POST /jobs; GET /jobs, /jobs/:id, /jobs/:id/results; POST /jobs/:id/cancel, /resume, /retry |
| Events | GET /events: SSE with optional job/watch filter and replay cursor |
| Coverage | GET /coverage, /coverage/:suffix: routing provenance and discovered/tested/unsupported status |
| Providers | GET /providers, /providers/:id; PATCH preferences; POST /providers/:id/catalog/refresh; PUT/DELETE /providers/:id/credentials; POST /providers/:id/credentials/test; readiness responses without secrets |
| External operations | POST /quotes, /provider-checks, /aftermarket, /transfers, /name-checks, /diagnostics; return job IDs |
| Evidence/cost | GET /domains/:asciiName/evidence, /offers, /price-history; POST /comparisons for explicit domain sets, horizon and region |
| Collections | List/create/update/delete collections and entries; notes, saved criteria and extension presets |
| Generation | POST /generation/preview: local candidates/rules/reasons; separate scan submission |
| Watches | List/create/update/pause/resume/delete watches; GET /watches/:id/events and /notices |
| History/data | GET /history; scoped DELETE operations preserving unrelated records |
| Artifacts | POST /exports, /snapshots: explicit scope/fields, downloadable local artifacts |

Externally querying operations accept Idempotency-Key. Persist its request fingerprint and returned job transactionally. Identical replay returns that job; conflicting reuse returns 409. Reconnect must not duplicate domain disclosures or quote requests.

Event envelope: contractVersion, eventId, type, occurredAt, jobId/watchId and validated payload. Types include job.updated, result.observed, quote.observed, watch.changed and source.cooldown. Persist state and events atomically. SSE uses monotonic IDs, Last-Event-ID replay, heartbeat, reconnect and duplicate suppression. Expired cursor explicitly requires state refetch. Retain substantive events with jobs; compact transient progress events with a 24-hour replay window. Authoritative results remain durable.

Public Zod schemas supply Nest DTOs and exported OpenAPI 3.0. Commit OpenAPI and the oapi-codegen Go client. Check regeneration drift and consumer compatibility on contract changes. Go's tested SSE reader handles replay and can fall back to status/result polling.

## Public evidence model

| Object | Fields and semantics |
| --- | --- |
| Input | Original input, Unicode display, canonical ASCII name, registration suffix, input row and validation/normalization reasons |
| Registry result | registered, no_record, inconclusive, rate_limited, blocked, invalid or unsupported; evidence IDs and separate eligibility |
| Eligibility | unknown, unrestricted, reserved or restricted only with sourced support and scope; never inferred from a missing record |
| Observation | Domain, source/protocol/destination, checkedAt, fetchedAt, expiresAt, cache state, reason, parser version and matched name |
| Provider capability | Exact suffix, links/catalog/check/quote/aftermarket/transfer support, account requirements, verification source/date and validation level |
| Provider confirmation | available, unavailable, restricted or unknown for the exact provider/name, independent source/time |
| Offer | Provider, name/suffix, purchase path, published/estimated/exact_quote kind, currency/region, terms, registration/renewal/transfer/fees, premiums/promotions, timestamps and destination |
| Partial error | Stable reason, affected item/source, retryability and cooldown; no conversion to zero or success |

Display “no registry record” (labelled "Not registered" in the UI, with a note to confirm with a provider) or time-stamped provider confirmation; no guaranteed registrable boolean. Preserve conflicting evidence. Expiry dates are facts, not drop predictions. Validate identity/shape of untrusted source data, bound response size/time and sanitize display/export text. Parsed evidence is default; sanitized raw diagnostics are opt-in with separate deletion. Routine logs omit full candidate lists and authenticated bodies.

## Registry routing and classification

Discover services using IANA RDAP bootstrap and registry WHOIS references. Cache dated metadata; ship dated startup defaults. Refresh discovery metadata without candidate names. Prefer documented registry RDAP; use WHOIS where verified routing/parsers cover namespaces without RDAP. Do not change protocol to evade cooldowns.

Candidate queries use reviewed registry destinations. Verify redirects/referrals; registrar/aggregator destinations need separate opt-in. Metadata existence means discovered support, not validated classification. Report each suffix's endpoint, protocol, fixtures and last live validation separately. Bootstrap counts are not working-TLD counts.

RDAP success must match the requested normalized domain. An authoritative correctly routed negative can mean no_record, not eligibility. WHOIS classifiers use registry-specific positive/negative/error fixtures. Empty, truncated or unknown text is inconclusive. Rate limits and blocks are distinct. Generic HTML 404 or a wrong endpoint is not authoritative domain absence.

tldts/IDN are helpers, not eligibility engines. Exclude private hosting suffixes, verify multi-label registration boundaries, validate A-label lengths and supported registry IDN rules, and flag ambiguous inputs. `.si` needs documented routing and positive/negative fixtures. Unsupported namespaces remain explicit; DNS absence is never an availability fallback.

## Job execution and recovery

Persist job type, operations/destinations, input, source policy, counters and times. Job states: queued, running, cancelling, cancelled, completed, completed_with_errors, interrupted. Item execution states: pending, running, finished, interrupted; source outcome is separate from execution state.

Use bounded global and per-source workers. Conservative defaults: 16 global requests, one in-flight request per registry and per authenticated provider account, and one second between registry request starts unless stricter rules apply. These are tunable engineering defaults, not allowed rates or speed guarantees. Documented limits and observed responses can slow them. All jobs/watches share source budgets; RDAP and WHOIS for one registry share cooldowns.

Honor Retry-After dates/seconds. Retry eligible transient network/server failures with exponential backoff and jitter, at most three attempts by default. No automatic auth/invalid/unsupported retries. A cooldown beyond the job deadline yields unresolved work with retryAt. Resume reconstructs unfinished work without repeating completed observations. Explicit stale rechecks create new observations.

Cancellation stops dispatch and aborts active calls where possible, retaining completed evidence and identifying unfinished work. Browser disconnect or CLI interrupt only stops observation; explicit cancellation stops a job. On interrupt the CLI writes the job ID to stderr for later inspection.

Handle 1,000+ unique domains without manual splitting: preview counts, paginate reads, bound memory and chunk exports. Validate capacity/recovery with deterministic transports. Do not run a 1,000-name public-registry stress test by default.

## Providers and pricing

All nine providers: Hostinger, Dynadot, Porkbun, Namecheap, GoDaddy, Cloudflare Registrar, Spaceship, NameSilo and Name.com. Add registry-published regional directories, particularly `.si`. Match exact registration suffixes.

The no-key experience includes direct registry discovery, verified provider directories/purchase links, and public catalogs where a dependable source exists. Porkbun's public standard-price catalog is a tested reference, not an exact-name quote. Published storefront information can be linked or sourced with dates where permitted; do not promise a machine-readable price feed for every provider. Missing public prices stay unknown. Authenticated operations are optional integrations activated through console/CLI configuration; they do not become prerequisites for using the app. Lack of keys must not trigger aggregator fallback or candidate disclosure.

Each adapter independently exposes directory/destination, catalogs, exact-name checks, quotes, transfer and aftermarket capabilities. Its manifest distinguishes documented, fixture-tested and live-tested support. Missing access returns credential_required; unavailable capabilities return unsupported. Failures preserve other providers and registry evidence. Provider preferences alone do not authorize domain disclosure; requested quote/check/watch operations record explicit names/destinations and need no repeated approvals.

Catalog retrieval avoids candidate submission. Exact offers preserve returned terms, standard/premium renewal, fees, tax, region and promotion eligibility, with missing values unknown. Hostinger availability plus billing catalog is not proven exact premium pricing. Cloudflare cached search differs from real-time checks. Use current documented GoDaddy auth/API, not inherited legacy assumptions. Refer to [official sources](REFERENCES.md#purchase-provider-references); never bypass CAPTCHAs or silently use aggregators.

Money is decimal strings with exact arithmetic. Rank only equivalent terms/currencies with complete relevant amounts. Base subtotal differs from a known total with fees; unknown tax is not zero. Three-year cost includes initial required commitment plus current renewal for remaining years. Show prepaid expense beyond the horizon separately if a minimum term exceeds it. Future renewal prices are estimates. Missing premium schedules, promotion eligibility or fees can prevent complete ranking. FX needs explicit attributed source/time; native-currency comparison works without it.

Keep append-only observations and original currencies. Registry/quotes become stale after 15 minutes; catalogs after 24 hours; honor earlier quote expiry. Cached reuse retains checkedAt. Failed refresh retains old stale values. Unknown-priced providers stay visible. Purchase links always match the displayed provider and purchase path.

## SQLite data model

Use foreign keys, WAL, versioned migrations and short transactions. One Nest process writes. UTC timestamps, money as text, validated JSON for flexible payloads; index relational identity/status/time fields.

| Logical tables | Contents and constraints |
| --- | --- |
| schema_migrations | Applied version/time, tested upgrades |
| jobs, job_items, idempotency_requests | Fingerprints, normalized inputs, state, attempts, counters; unique name/operation per job |
| registry_sources, suffix_rules, source_cooldowns | Dated routes/rules/parser versions, shared retry times |
| observations | Sourced immutable evidence; index domain/source/time |
| providers, provider_capabilities, catalog_observations, offers | Exact suffix support, validation, costs/terms/history; no secrets |
| collections, collection_entries, saved_criteria, extension_presets | Notes, evidence links and restorable settings without automatic queries |
| watches, watch_runs, notices | Explicit source policy, next check, comparable prior evidence, missed intervals and deduplicated changes |
| events | Monotonic cursor/payload, atomic with state changes |
| portfolio_entries, snapshots, settings | User facts, artifact manifests and ordinary preferences |

Separate immutable observations from current projections. Reference shared evidence so deleting a job does not silently break a shortlist. Index item status, cooldowns, history, watch due time and event cursors. Use bounded batches to avoid stalling the synchronous SQLite driver. Preserve user data until scoped deletion; only transient progress compaction is automatic. Deletion preserves unrelated records and accounts for active WAL files. Never delete original imports or the repository during app-data cleanup.

## Complete workflow mapping

| Requirements | Shared service behavior |
| --- | --- |
| A01-A09 | Validation, registry routing/evidence and rechecks |
| B01-B08 | Input expansion, durable bulk jobs, progress/recovery and source limits |
| R01-R09 | Nine-provider support/access/destinations and preferences |
| P01-P10 | Catalogs/quotes, terms/fees/premiums/promotions, costs and freshness |
| S01-S08 | Filters, collections/notes/criteria, details and scoped exports |
| G01-G08 | Go/API parity, machine output and optional MCP behavior |
| N01-N05 | Local rules/generation/edit/preview before separate scan |
| W01-W05 | Explicit watches, pause/resume, sourced changes and notices |
| H01-H04 | Comparable observed-price history, gaps, export/deletion |
| F01-F05 | Sourced aftermarket, read-only transfer and portfolio comparisons |
| X01-X05 | Requested namespace checks with independent uncertainty |
| D01-D04 | Requested DNS/DNSSEC/TLS/HTTP diagnostics with destination evidence |
| Unnumbered requirements | Complete accessible UI, privacy controls, snapshots and local runtime |

Generation is local roots/themes/affixes/syllables/mutations/domain hacks, without an AI service. Saved criteria restore editable inputs without queries. Watches compare equivalent successful evidence; network failures or missing prices never create change notices. Notices are in-app and agent-readable, with no email or OS notification permission required.

Name-check manifests declare exact namespaces, such as GitHub user/organization, npm package or PyPI project. Advertise only tested dependable supported interfaces. Social services without suitable access remain unsupported rather than invented scrape-success. Selected diagnostics declare resolver/targets and cannot change registry outcomes.

Aftermarket retains marketplace, fixed/auction/offer state, price and source age without claiming seller verification. Transfers are read-only with no authorization-code handling. Portfolio entries distinguish supplied facts from quotes. Snapshots are self-contained HTML plus structured data, escaped, credential-free, with no service-query scripts or required CDN assets; omit private notes unless selected.

## Go command contract

Executable: domain-scout. Default output JSON; --output table for humans, --output ndjson for streams. stdout is requested data only; progress/setup/errors go to stderr. --no-input is accepted throughout and commands never unexpectedly prompt or install software.

| Commands | Purpose |
| --- | --- |
| service start/status/stop, ui | Local lifecycle and browser launch |
| input preview, scan | Normalization/submission; --file, stdin, --tlds, --preset; registry-only |
| jobs list/show/results/watch/cancel/resume/retry | Durable operations; scan --wait waits, ordinary submission returns job ID |
| coverage list/show | Proven versus discovered support |
| providers list/show/configure, catalog refresh | Capabilities, local credential readiness and catalogs; no secret stdout |
| provider-check, quote, compare | Explicit provider requests and cost comparison |
| shortlist list/create/add/remove/show, notes set | Persistent collections/notes |
| criteria list/save/show/delete, presets list/save/delete | Restorable filters/generation settings and extensions |
| generate | Local suggestions/preview, no implicit scan |
| watches list/create/show/pause/resume/delete, notices list | Monitoring and retained changes |
| history list/show, prices history | Retained evidence and comparable prices |
| aftermarket, transfer compare, portfolio import/show/compare | Other purchase paths and ownership research |
| name-check, diagnose | Selected external checks |
| export, snapshot | Explicit selection/filtered/shortlist/all scope and chosen fields/format |
| data inspect/delete | Explicit scoped local deletion; require --yes for non-interactive deletion |

Global flags: --output, --no-input, --quiet, --backend-url, --data-dir, --timeout. Scan never implies quotes; enrichment requires explicit providers and names. Export --scope requires matching filter/selection/job/collection. TXT candidates retain uncertainty context in metadata/stderr, never a guarantee.

Use one backend filter/sort specification for paginated result views, CLI queries and exports. Filtered exports apply to the complete matching dataset, not merely the loaded page or virtualized rows. Resolve the explicit scope to stable item/evidence IDs at export creation so subsequent job updates do not silently change that artifact. Snapshots retain those IDs and source times.

Exit codes: 0 successful command/submission, 1 local operation failure, 2 invalid request/usage, 3 completed job with unresolved items, 4 required provider access missing, 5 backend setup/version failure, 130 interrupted client wait. Taken names are valid results. Invalid rows in a valid preview are data. Partial results stay parseable at exit 3. Asynchronous exit 0 confirms submission only.

## Functional frontend scope

Piyush explicitly asked to leave visual design out of this planning pass. The handoff defines what the frontend does, without selecting a layout, theme style or mockup. Visual work follows the user's applicable design instructions during implementation; no further layout selection is required to finish this plan or start backend/CLI work.

Functional routes include /scan, /jobs/[id], /domains/[name], /collections/[id], /discover, /monitoring, /history, /compare and /settings. Scan previews validation/count before running. Results show partial progress, independent outcomes, freshness, complete selection/filter/export. Details separate evidence from offers and diagnostics. Provider integration settings configure optional credentials. Preserve context during navigation.

Small screens use separate detail/comparison views; cancellation/progress stay accessible. Require keyboard use, focus, contrast, text beside colors and light/dark themes. No taglines, slogans, subtitles or filler. No misleading positive availability badge for unresolved evidence.

## Verification and completion

Track all 80 requirement IDs, unnumbered UI/privacy/sharing behavior and all 19 product acceptance scenarios. Distinguish fixture-tested, live-tested and not tested. Documentation or mocked tests do not prove current real-world source coverage.

Focused tests: normalization/IDN/boundaries, source identity/classifiers, shared cooldowns, retries, cancel/recovery, quotes/money/completeness, export scopes, watch changes and contract compatibility. Use real temporary SQLite DBs for migrations/recovery and injected transports for source failures and destination/secret checks. No public stress test by default.

Validate representative registries including `.si` with source provenance and authorized live names when available. Test every advertised provider capability, not just one quote adapter. No registrar credentials are currently available: verify optional authenticated adapters with sanitized fixtures and test missing/configured/expired-key states, while labeling live execution unverified. Demonstrate live exact-name quotes after authorized account access is supplied; live authenticated tests are not a gate to delivering the no-key app and integration controls. Never replace missing credentials with fabricated quote success.

Go tests cover command/output/error/stream behavior and API compatibility. Nest/Next use targeted tests, typecheck and lint before full builds. Playwright exercises the human workflow during a 1,000-item deterministic batch, themes, keyboard, exports, reloads and access boundaries. Run equivalent CLI workflows against the same backend, test process restart and selected OS packages, and record measured results.

Target packaged platforms: macOS arm64/amd64, Windows amd64, Linux amd64/arm64. These architectures are engineering defaults covering common systems, not user-selected hardware. Verify compatible native SQLite/Node assets for each; report untested targets rather than claiming support from Go cross-compilation alone. Provide equivalent setup, launch, paths and process handling on all three OS families, without shell-specific global dependencies.

Done means the full UI/CLI scope works, keyless capabilities have evidence, optional integration controls/adapters are tested to their stated level, uncertainty and costs are honest, state survives intended recovery, exports match scope, and local distribution works on the selected platforms without hosting. MCP is optional. Missing live account tests remain explicitly unverified in the build report.

## Public project reference map

These are references, not applications to fork wholesale. Latest default-branch commit dates below were checked October 5, 2026; pinned revisions, all 13 projects, licenses and maintenance limits are in SOURCE_REVIEW.md. Recent activity does not prove protocol correctness.

| Public project | Last commit | Use in this build |
| --- | --- | --- |
| [WhiteBite/Domain-Hunter](https://github.com/WhiteBite/Domain-Hunter) | 2026-10-04 | Primary exercised reference: bootstrap, queues, catalogs, generation and agent contracts. Inspect the pinned local trial; correct observed disclosure/classification/export/link gaps. Latest activity is automated pricing, not proof of engine fixes. |
| [openrdap/rdap](https://github.com/openrdap/rdap) | 2026-09-23 | Endpoint discovery, bootstrap cache and RDAP semantics. Go reference only: the actual scanner stays in Nest. |
| [saidutt46/domain-check](https://github.com/saidutt46/domain-check) | 2026-09-28 | Bulk expansion and CLI/MCP patterns; review known short-response/retry weaknesses before reusing ideas. |
| [jedarden/domain-check](https://github.com/jedarden/domain-check) | 2026-09-18 | Local app/CLI/watch organization; advertised accuracy remains unverified. |
| [ricky9w/namestack-domains](https://github.com/ricky9w/namestack-domains) | 2026-09-16 | Structured read-only agent results, evidence and partial failure behavior. Provider-mediated checking differs from registry-only discovery. |
| [zemse/domain-utils](https://github.com/zemse/domain-utils) | 2026-06-06 | Explicit enrichment, pricing attribution, cache and independent diagnostics. |
| [codeatlasdev/domain-hunter](https://github.com/codeatlasdev/domain-hunter) | 2026-09-10 | Broad provider directory including Hostinger; provider count and DNS heuristics are not live quote/availability proof. |
| [weppos/whois-parser](https://github.com/weppos/whois-parser) | 2022-09-08 | Historical registry-specific fixtures; refresh against current sources, not a maintained scanner foundation. |

The broader review also covers knightsri/domain-checker, PlayerYK/dmcheck, dorukardahan/domain-search-mcp, Rasaboun/dispo and MarsHeer/agentdomain-mcp. dmcheck is AGPL-3.0; do not copy code without checking compatibility. Verify license files/notices for any copied material. Provider API references and direct standards are linked in REFERENCES.md. The chosen protocol transport remains Node fetch/net; do not add a Go scanning dependency merely because a reference is written in Go.

## Implementing agent instruction

When Piyush explicitly says to build, read these documents and AGENTS.md and implement inside this repo. That later instruction supersedes the planning-only boundary. Keep settled Go/Nest/Next, full scope, local execution, three-OS coverage and privacy; do not ask for redundant scope/stack approval. Visual design was intentionally excluded from this pass, not forgotten. Preserve all no-key workflows and offer optional key-based integrations through settings/CLI. Do not commit, push, publish or modify anything outside this project without explicit instruction.
