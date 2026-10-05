# Domain Scout product requirements

Complete product scope for the build handoff, updated October 5, 2026. This document defines what to build, its defaults, boundaries and acceptance conditions. It contains no effort estimates, release phases or implementation sequence. These are planned requirements, not implemented capabilities or authorization to start coding.

The deployment and stack are settled: local NestJS backend, Next.js frontend, Go CLI and SQLite persistence, targeting macOS, Windows and Linux. MCP is optional afterward. [Local application fundamentals](PLAN.md#local-application-fundamentals), [selected stack](TECH_STACK.md), [engineering handoff](BUILD_HANDOFF.md). Visual design is intentionally outside this planning pass; functional UI requirements remain included.

Domain Scout will help coding agents and Piyush turn candidate batches into a shortlist, understand each result, find purchase providers, and compare prices where reliable information exists. Coding agents are the primary users; Piyush needs a complete human UI for the same workflow.

Piyush has chosen our own product, a complete UI redesign, broad TLD support wherever feasible, bulk workflows, and purchase-provider coverage including Hostinger. Existing projects provide references and selectively reusable components. The repository remains private. This document does not start application implementation.

The source review covers 13 public repositories, official documentation for nine purchase providers, protocol references, and our live Domain Hunter trial. Only Domain Hunter was installed and exercised end to end. Advertised features and coverage from other projects remain unverified. See [the source review](SOURCE_REVIEW.md), [the trial](TRIAL.md), and [the reference map](REFERENCES.md).

## Product outcome

A user should be able to answer these questions for a shortlisted name:

1. What did the registry report, and when was it checked?
2. Which providers support this extension, and where can I start registration?
3. Has a selected provider confirmed this exact name is purchasable?
4. What does registration cost, what does renewal cost, and which details are unknown?
5. What is the next action: recheck, obtain a quote, review restrictions, or open the matching purchase destination?

These are separate facts. A missing registry record is not a confirmed purchase opportunity. Provider support is not a domain-specific quote. A quote does not reserve a domain or complete registration.

## Complete build scope

| Area | Planned capability |
| --- | --- |
| Registry checks | Single domains, bulk lists, extension expansion, internationalized names, registry evidence, restrictions and honest unresolved states |
| Bulk jobs | Progress, cancellation, recovery, resume, selective retry and shared source cooldowns |
| Purchase providers | Hostinger, Dynadot, Porkbun, Namecheap, GoDaddy, Cloudflare Registrar, Spaceship, NameSilo and Name.com, plus extensible regional directories |
| Pricing | Published prices and supported exact-name quotes; registration, renewal, transfer, premiums, terms, promotions, currency, ownership estimates and observed price history |
| Discovery | Local candidate generation, reusable extension presets and saved search criteria |
| Results | Search, filters, sorting, saved shortlists, scan history, evidence details and explicit export scopes |
| Monitoring | User-configured checks of selected domains and supported prices, with local change notices |
| Other purchase paths | Separate aftermarket listings and read-only transfer or portfolio cost comparisons |
| Optional enrichment | Social, GitHub and package-name checks, plus DNS, TLS and website diagnostics |
| Human UI | A complete new interface for every included workflow, accessible on desktop and smaller screens |
| Agent access | Non-interactive CLI with structured results and equivalent essential capabilities; optional MCP adapter |
| Sharing | Deliberate, local result snapshots with explicit selection and privacy controls |
| Purchase handoff | Open the matching provider destination for external checkout |

All rows belong to the product plan. User-requested features such as monitoring or external enrichment are optional to run, not deferred to another phase. MCP is a separately optional interface, as Piyush suggested. Provider and extension capabilities depend on verified source support: a provider with only a verified purchase link remains useful, and missing prices do not block registry checks.

## Availability requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| A01 | Check individual domains and batches against identified registry services | Every requested valid domain receives a result or an explicit unresolved state |
| A02 | Support extensions wherever reliable public lookup is feasible, including `.si` | Report verified support, discovered but untested support, and unsupported cases separately |
| A03 | Validate and normalize inputs, including internationalized names | Preserve original input, show the normalized domain, and identify invalid items before querying |
| A04 | Handle boundaries such as `.co.uk` and `.com.au` | A hostname or private-service suffix is not silently treated as a purchasable registry domain |
| A05 | Distinguish registered, no registry record, inconclusive, rate limited, blocked, invalid and unsupported outcomes | Timeout, absent DNS, malformed data, empty WHOIS and unknown extensions never become positive availability results |
| A06 | Identify reserved or restricted names when a source establishes that status | Unknown eligibility stays unknown; provider restrictions do not become a global taken classification |
| A07 | Attach evidence to every result | Identify source, protocol, check time, cache state and reason; returned registration records must match the requested domain |
| A08 | Keep registry evidence and provider confirmation separate | Conflicting results remain visible with their sources and timestamps |
| A09 | Refresh selected domains before purchase | Fresh checks retain prior evidence; old results remain identifiable |

These requirements combine user goals, trial findings, and protocol constraints. Public registry lookups cannot establish universal purchase eligibility. [RDAP response semantics](https://www.rfc-editor.org/rfc/rfc7480.html#section-5.3), [domain provisioning checks](https://www.rfc-editor.org/rfc/rfc5731.html#section-3.1.1), [Public Suffix List](https://publicsuffix.org/).

## Bulk workflow requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| B01 | Accept pasted domains, TXT and CSV files, and agent input through files or stdin | Show imported, invalid and duplicate counts without silently dropping entries |
| B02 | Expand base names across selected extensions | Preview unique domains and total checks before starting; complete-domain inputs retain their extension |
| B03 | Offer reusable extension selections and user-defined presets | The same preset is usable through the UI and agent access |
| B04 | Stream progress while scanning | Show completed, pending and unresolved counts; completed results are usable before the batch finishes |
| B05 | Cancel and resume batches | Completed results survive interruption; resume avoids unnecessary repeats and preserves original check times |
| B06 | Retry selected failures | Successful work stays intact; one failed source does not restart the batch |
| B07 | Respect registry limits across all jobs | Observe cooldowns and Retry-After; do not switch protocols or intermediaries simply to evade limits |
| B08 | Process thousands without manual splitting into small batches | Validate at least 1,000 unique domains after expansion; larger inputs use the same recoverable workflow without a registrar-style 50 or 100 name limit |

The 1,000-domain target concerns workflow capacity, not guaranteed registry throughput. Completion time depends on sources and their limits. This is a product acceptance target, not a benchmark established by the references. [Batch references](SOURCE_REVIEW.md#ideas-to-combine), [RDAP rate limits](https://www.rfc-editor.org/rfc/rfc7480.html#section-5.5).

## Purchase provider requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| R01 | Include all nine named providers and extensible regional directories | Publish verified extension support and available capabilities per provider; additions preserve the existing workflow and result meanings |
| R02 | Describe each provider capability separately | Identify extension support, purchase links, catalogs, availability confirmation and domain-specific quotes independently |
| R03 | Match providers to actual registration extensions | Do not assume `.uk` support implies `.co.uk` support or identical prices |
| R04 | Support providers with no automated price source | Show their purchase destination and explicit price-unknown state |
| R05 | Keep source and freshness for provider information | Extension support and link templates have a verification source and date |
| R06 | Keep purchase destinations consistent | Displayed provider, quoted price and link refer to the same provider; dashboard-only destinations are labeled |
| R07 | Isolate provider failures | Catalog outages, expired tokens or unsupported quotes do not invalidate registry evidence or other providers |
| R08 | Allow enabled, disabled and preferred providers | Preferences affect presentation; cheapest rankings still use comparable known prices |
| R09 | Explain account requirements and configure optional integrations | UI console/settings and CLI allow optional key/token setup, test and disconnect without exposing saved secrets; missing access produces a useful setup state, and registry discovery needs no provider credentials |

Hostinger is an explicit user requirement. The other eight named providers are included in this complete plan based on the source review. Implement their best verified capabilities, including exact-name checks and quotes where available. Provider presence never implies that every extension has live pricing. [Official provider sources](SOURCE_REVIEW.md#purchase-provider-documentation).

## Pricing requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| P01 | Label published standard prices, estimates and exact-name quotes | Every price identifies its type and source |
| P02 | Show registration and renewal separately | Include term, minimum commitment, currency and region where relevant; first-year promotion is not the whole purchase cost |
| P03 | Show premium status and fees when known | Confirmed premiums and heuristic hints differ; unknown renewal or tax information is not zero |
| P04 | Compare like-for-like offers | Rank comparable terms and currencies; incomplete prices stay visible but cannot claim a confirmed cheapest total |
| P05 | Compare initial commitment and a three-year ownership estimate | Identify mandatory multi-year terms; future renewal costs remain estimates based on current data |
| P06 | Keep publication, fetch and quote times where supplied | Cached catalogs retain their age; expired or stale quotes cannot appear newly verified |
| P07 | Obtain supported live quotes for selected names and providers | Candidate disclosure is explicit; missing premium, renewal or fee fields stay unknown |
| P08 | Preserve useful catalog data during failed refreshes | Old values are labeled stale and never silently replaced with zero or supposedly fresh data |
| P09 | Keep currencies precise and identifiable | Original currency remains visible; conversions include source and time |
| P10 | Explain promotions and their eligibility | Show required term, customer/account restrictions and expiration when supplied; unverified coupons are never applied to a confirmed total |

Default: published price information may load without submitting candidate names; domain-specific provider checks and quotes require an explicit requested operation. A person or an agent may initiate it. A selected provider preference can persist; repeated approval dialogs are not required for the same authorized workflow.

Provide exact-name confirmation and quotes wherever the named providers offer a verified accessible interface. Test every advertised capability to its stated level. Piyush has no registrar API access now: the no-key app and optional integration controls must work, while authenticated adapters use sanitized fixture tests and remain live-unverified. Demonstrate exact-name quotes when authorized access is configured, without making keys a prerequisite for delivery of the keyless app. Unsupported extensions and missing prices remain explicit limitations.

Cloudflare documents separate cached search and real-time availability/pricing checks. Hostinger documents availability and a separate catalog, which does not itself prove exact-name premium pricing. These differences justify capability-specific support. [Cloudflare Registrar API](https://developers.cloudflare.com/registrar/registrar-api/), [Hostinger availability](https://github.com/hostinger/api-python-sdk/blob/main/docs/DomainsAvailabilityApi.md), [Hostinger catalog](https://github.com/hostinger/api-python-sdk/blob/main/docs/BillingCatalogApi.md).

## Results and shortlist requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| S01 | Filter and sort by name, extension, registry outcome, provider confirmation and price | Unresolved results remain accessible and countable |
| S02 | Save a local shortlist across sessions | Preserve evidence, last check and purchase information |
| S03 | Recheck or enrich selected entries in bulk | Operate only on the requested selection; show progress and failures |
| S04 | Expose returned registration details | Show dates, status, registrar and nameservers without inventing holder details or treating expiry as a guaranteed drop date |
| S05 | Inspect source evidence on demand | Human summaries stay readable; raw diagnostics are available separately |
| S06 | Export TXT, CSV and JSON with an explicit scope | Selected rows, filtered rows, shortlist or all rows; exports match their chosen scope exactly |
| S07 | Preserve uncertainty in exports | Plain candidate lists are labeled; structured exports retain statuses, source, check time and price type |
| S08 | Save search criteria and organize shortlists | Named collections retain notes, filters, extensions, selected providers and budget settings; restoring criteria does not run queries automatically |

Our trial's default CSV included all rows after filtering, and one taken-domain row paired a Cloudflare price with a Dynadot destination. These observations motivate explicit export scope and consistent links, not a claim that all existing tools lack these features. [Trial evidence](TRIAL.md).

## Human interface requirements

A complete redesign is required, using Next.js as the selected frontend. This plan defines functional behavior; Piyush explicitly excluded visual layout/design from this planning pass.

| Area | Required experience |
| --- | --- |
| New scan | Paste or import names, choose extensions or presets, inspect validation and projected work, then start |
| Results | Clear progress, partial results, readable status and freshness, search, sort, filter, selection and export |
| Domain details | Registry evidence, restrictions, provider support, registration/renewal prices and matching destinations |
| Shortlist | Review candidates, refresh evidence, request supported quotes and export |
| History | Restore inputs, selections and results; resume incomplete work without losing context |
| Discovery | Generate and edit candidate lists, choose saved criteria and preview expanded query counts |
| Monitoring | Manage selected watches, inspect changes, pause checks and see source failures |
| Price and purchase details | Compare ownership costs and observed prices; distinguish new registration, transfers and aftermarket listings |
| Optional checks | Inspect requested brand-name results and registration diagnostics with their own sources |
| Sharing and data controls | Choose snapshot contents, export reports and deliberately remove local data by collection or type |
| Provider settings | Capabilities, key/token integration setup, test/disconnect, source failures and preferences; secret inputs are masked and saved credentials never returned |
| Accessibility | Keyboard access, visible focus, readable contrast, text alongside status colors, and usable smaller-screen layouts |
| Appearance | Cohesive light and dark themes, restrained controls, no slogans or instructional filler |

Changing views must preserve the scan and shortlist. Visual prominence must not imply confirmed prices or purchase eligibility. Routine checks need no repeated modal confirmations. Technical details belong in evidence or settings views when they help a decision.

## Agent requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| G01 | Provide CLI access to all planned workflows and allow an optional MCP adapter | Checks, jobs, coverage, providers, quotes, generation, saved criteria, monitoring, history, optional checks and exports behave consistently; MCP reuses the same capabilities when added |
| G02 | Return versioned structured results | Agents identify the output contract without parsing human tables |
| G03 | Support non-interactive use | Missing credentials and invalid input fail clearly without unexpected login or prompts |
| G04 | Separate machine data from progress | Outputs stay parseable in successful, partially failed and cancelled runs |
| G05 | Make long jobs inspectable and resumable | Agents identify a batch, retrieve progress/results, cancel and resume recoverable work |
| G06 | Support registry-only discovery and selected provider enrichment | Quote operations never run silently as a discovery side effect |
| G07 | Return actionable errors | Identify affected domain/source, retryability, cooldowns and missing access |
| G08 | Expose essential purchase information to agents | Implemented confirmation and quote details needed for decisions are available beyond the UI |

The trial established that a shared UI, CLI and MCP workflow is feasible. Namestack's documented structured results, non-interactive mode and partial failures are further references, not an adopted API design. [Agent references](SOURCE_REVIEW.md#ideas-to-combine).

References to MCP in acceptance conditions describe its behavior if added. They do not require MCP before the CLI or UI can satisfy the product workflows.

## Privacy and reliability requirements

- Registry discovery sends names only to identified registry services by default. Unverified redirects and fallbacks must not silently broaden disclosure.
- Provider confirmation, quotes and external enrichment identify their destinations and run only when requested under the chosen policy.
- No analytics or remote synchronization is required. History and shortlists stay local; offer deliberate controls to remove local data.
- Keep secrets out of exports, responses, screenshots, share destinations and routine diagnostics. Optional local candidate-request diagnostics remain visible and controllable.
- Discovery needs no paid aggregator subscription or third-party API key. Optional provider credentials never become registry-check prerequisites.
- Preserve partial success through failures, cancellation and supported restarts. Distinguish old data from new checks.
- Cached history and exports remain usable offline; live checks and quotes report that they need a connection.
- Keep the UI responsive during the 1,000-domain acceptance workload. Measure this before claiming the target is achieved.
- Keep the repo private until Piyush authorizes publication. Review source licenses before copying code.

Registries and requested providers can observe queries. Zero logging, zero front-running risk, unlimited speed and guaranteed registration are not product claims.

## Candidate generation requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| N01 | Generate candidates locally from user roots, themes, prefixes and suffixes | Generation needs no external AI service or account; supplied and generated names remain editable |
| N02 | Include syllable combinations, name variations and domain hacks | Explain the generation rule; invalid or ambiguous registration boundaries are flagged |
| N03 | Apply chosen length, character and extension rules | Preview unique candidates, duplicates, invalid names and expanded query counts |
| N04 | Review candidates before querying | Generation itself sends no candidate to a registry or provider; only selected candidates enter a scan |
| N05 | Share generation behavior with agents | CLI and the optional MCP adapter can generate, inspect and submit candidate selections separately |

Generation produces suggestions, not trademark clearance or guaranteed desirable names. People and coding agents can also supply candidates directly.

## Monitoring requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| W01 | Monitor only explicitly selected names and sources | Each watch records its interval, destinations and whether provider prices are included |
| W02 | Record meaningful changes with before and after evidence | Availability transitions and comparable price changes include timestamps and their sources |
| W03 | Keep failures separate from changes | A timeout, expired token or missing field never creates an availability or price-drop alert |
| W04 | Provide local notices and inspectable events | Notices and agent-readable events lead to retained evidence; repeated identical observations do not duplicate alerts |
| W05 | Pause, resume and remove watches | Honor source cooldowns; show missed checks while the application is stopped, without implying continuous cloud monitoring |

Monitoring never registers a name or promises it will still be purchasable when a notice is opened. Provider watch requests use the explicitly configured disclosure policy.

## Price history requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| H01 | Retain observed catalogs and quotes | Preserve provider, extension or exact domain, amount, currency, term, price type and observation time |
| H02 | Compare equivalent observations | Region, term, renewal and promotion differences remain identifiable; unmatched records are not a price trend |
| H03 | Show historical comparisons without inventing data | Missing periods stay missing; importing a current catalog does not fabricate earlier prices |
| H04 | Export and remove local history deliberately | Export scope is explicit and contains no credentials; clearing history does not silently erase unrelated shortlists |

## Other purchase paths requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| F01 | Show sourced aftermarket listings for registered names | Clearly identify listing, auction, make-offer or fixed-price status, marketplace, currency and observation time |
| F02 | Keep listing evidence separate from purchase confirmation | A listing URL or asking price is not proof of seller authority, checkout availability or final acquisition cost |
| F03 | Compare read-only transfer options | Include transfer price, known eligibility and included term; do not request authorization codes or initiate transfers |
| F04 | Compare portfolio costs from imported domain lists | Accept user-supplied renewal dates and prices; separate observed facts, user entries and estimates |
| F05 | Hand off the selected purchase path | New registration, aftermarket acquisition, renewal and transfer destinations have clear labels and matching providers |

Use publicly documented sources and optional authorized accounts. An unsupported marketplace or missing transfer quote remains unknown. No account-wide domain changes are in scope.

## Optional name checks requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| X01 | Check supported social handles, GitHub names and package names | Publish the supported services and exact identifier type; unsupported services remain explicit |
| X02 | Run only the selected external checks | Identify destination services before querying; scanning registry availability never starts these checks implicitly |
| X03 | Separate existence, apparent absence, restrictions and errors | A missing public profile or package is not labeled guaranteed claimable; access denial remains unresolved |
| X04 | Preserve independent evidence | Domain ownership, GitHub namespace, social handle and package-name results do not overwrite one another |
| X05 | Make results available to people and agents | UI, CLI, MCP and scoped exports show source, check time and uncertainty |

These checks help naming consistency. They do not establish trademark rights or permission to use a brand.

## Diagnostic requirements

| ID | Required behavior | Acceptance condition |
| --- | --- | --- |
| D01 | Inspect requested DNS, nameservers and DNSSEC information | Identify the resolver or other destination, record the observed answer and distinguish lookup errors |
| D02 | Inspect requested TLS and website information | Record certificate and HTTP observations with their times; unreachable services stay unresolved |
| D03 | Keep diagnostics independent of availability | No DNS answer, failed TLS or an absent website can turn a registered or inconclusive domain into an available one |
| D04 | Expose selected diagnostics across interfaces | UI, CLI and MCP use the same evidence and errors; optional checks need no paid aggregator |

## Sharing requirements

Create a local snapshot of selected results as an exportable report. The user chooses names, prices and evidence included. Omit credentials and private notes by default; inspect included data before saving. Snapshots preserve observation times, uncertainty and price types, work without rerunning queries, and do not start scans when opened. Provide the same operation to agents. Public hosting or automatic remote sharing is outside scope.

## Product defaults

These defaults complete the behavior plan and may be changed in settings. They are product choices, not values established by the reference projects.

| Setting | Planned default |
| --- | --- |
| Discovery destinations | Registry services only; no silent registrar, aggregator, DNS or telemetry fallback |
| Provider checks and external enrichment | Explicitly requested selected operations; saved choices can be reused without repeated confirmations |
| Price loading | Published catalogs may load without candidate names; exact-name quotes do not run automatically |
| Evidence age | Always show observation time; mark registry evidence stale after 15 minutes and catalogs stale after 24 hours |
| Quote age | Respect a provider-supplied earlier expiry; otherwise mark quotes stale after 15 minutes; observation time is never a reservation |
| Purchase readiness | Offer a selected recheck and supported quote refresh; show missing or stale confirmation before handoff |
| Ownership comparison | Show initial required commitment and a three-year estimate using current renewal rates, with a selectable horizon |
| Currency and region | Preserve the source currency and explicit provider region; use a selected comparison currency only when an attributed conversion is available |
| Export scope | UI defaults to the current filtered view; agent export commands declare scope; candidate TXT defaults to shortlisted names with no registry record or positive provider confirmation |
| Price ranking | Rank complete comparable prices, label estimates, and keep unknown-priced providers visible |
| Monitoring | Disabled until configured; runs while the local backend is active, including with the browser closed; default requested interval is daily, subject to source limits |
| Local data | Preserve history and shortlists across sessions until explicitly removed; support deletion by collection or data type |
| Sharing | Local snapshots; no automatic upload or execution of queries |

A TXT candidate list is never presented as a guaranteed registrable inventory. Snapshot age and quotes have independent freshness states; shortening a setting cannot erase original timestamps.

## Scope boundaries

Automatic registration, payments, wallets, DNS changes, hosting deployment, drop-catching and universal trademark clearance are outside this product scope. Documentation showing that these operations exist does not make them Domain Scout requirements.

## Product acceptance scenarios

1. Import complete domains, base names, duplicates and invalid items. Preview normalized work and explain excluded or ambiguous input.
2. Run a 1,000-domain acceptance workload and verify that larger input is not arbitrarily capped. Keep UI and agent outputs usable, account for each item, cancel partway and resume without losing completed evidence.
3. Mix registry successes with timeouts, rate limits, blocked responses and malformed data. Preserve successes and never classify unresolved requests as available.
4. Validate representative gTLDs, `.si`, a WHOIS-supported ccTLD, a multi-label suffix, an internationalized name, an unsupported extension and a source-confirmed restricted or reserved case. Publish the validation set and its limits.
5. Account for all nine named providers and their verified extension capabilities, including Hostinger. Link-only providers remain useful when prices are missing.
6. Compare public catalogs and supported exact-name quote fixtures, validate optional credential configuration and missing/expired-access behavior, and test every advertised adapter capability. Validate live exact-name quotes after authorized keys are configured; label them unverified beforehand. Display source, currency, term, renewal, fees, premium status and freshness without declaring an incomplete total cheapest.
7. Fail one catalog or authenticated provider check. Preserve registry evidence and other providers' results.
8. Filter, select and shortlist, then export each scope. Exported names match the scope and retain uncertainty.
9. Complete the same core workflow through UI and CLI. Check equivalent evidence, parseable output and non-interactive errors; apply the same checks to MCP when its optional adapter is added.
10. Inspect destinations: discovery sends names only to registry services; enrichment reaches declared destinations; outputs contain no secrets.
11. Generate candidates locally, edit them, apply naming rules and preview expansion without making network requests until selected scanning starts.
12. Save criteria and shortlists, restart the application, restore history and inspect retained observed-price comparisons without inventing missing periods.
13. Configure and pause a watch, simulate a meaningful change and a network failure, and verify that only the supported change creates a notice. Show missed checks after downtime.
14. Inspect aftermarket evidence and transfer or portfolio comparisons. Keep acquisition paths separate, retain missing costs and perform no purchases or account changes.
15. Run selected social, GitHub, package, DNS, TLS and website checks. Preserve independent uncertainty and confirm they do not change registry outcomes.
16. Produce a local share snapshot with selected evidence. Verify no credentials or default private notes are included, and opening it causes no queries.
17. Advance observation time past the defined defaults, preserve source timestamps and verify independent stale states for registry evidence, catalogs and quotes.
18. Use keyboard navigation, light and dark themes and a smaller screen to complete the planned human workflows while a batch is active.
19. Launch from the UI and CLI, verify shared backend jobs and local state, close the browser without losing active work, then interrupt and restart the backend. Inspect retained results, unfinished jobs and missed watch checks without a hosted service.

These are acceptance scenarios for the eventual build, not checks performed during this planning task. Registrar confirmation remains a time-stamped observation and checkout is external.

## Ready for the coding agent

Product scope, defaults, workflows, acceptance conditions and Go/NestJS/Next.js choices are complete for handoff. All named capabilities remain included without phases or estimates. Public-source coverage and authenticated live validation retain explicit limits. Visual design was intentionally excluded from this planning pass.

[TECH_STACK.md](TECH_STACK.md) records selected technologies; [BUILD_HANDOFF.md](BUILD_HANDOFF.md) records contracts, modules, local runtime, SQLite, CLI commands, credential controls, references and checks. No blocking product/stack questions remain. Application implementation requires Piyush's separate instruction to the coding agent.
