# Domain Scout planning

Status: planning only. Piyush requested saved findings and a private GitHub repository, with continued planning until an explicit decision to build. The proposals below have not been accepted as implementation choices.

## Established direction

- The project should support TLDs wherever public registry services make reliable checks possible.
- Candidate discovery should avoid paid aggregators and registrar storefronts.
- Large batches and useful exports are central to the workflow.
- Results should help the user find registrars that offer the extension, compare pricing where possible, and inspect relevant registration details.
- Coding agents are the primary users. Piyush will use a UI.
- Availability checks, purchase information, and bulk workflows are distinct parts of the product, described in [the product requirements](PRODUCT.md).
- The repository remains private during planning and implementation. Open sourcing after completion is a possible later decision.
- Planning and research come before application implementation.

## Proposed first version

A local engine would query HTTPS RDAP services discovered through IANA, with verified WHOIS adapters where useful. It would accept complete domains or expand labels across selected extensions, normalize internationalized names, remove duplicates, and handle registration boundaries such as .co.uk.

Requests would use bounded concurrency and shared pacing per registry infrastructure. Rate limits, timeouts, and access restrictions would remain visible results. Completed results would be preserved for interruption recovery, with timestamps and an explicit recheck workflow for old shortlist entries.

Exports would include a TXT shortlist and CSV or JSON results with the domain, result category, protocol, endpoint, check time, and reason. A separate registrar directory would supply provider links for supported extensions. Published standard prices could be gathered without submitting candidate names. Exact quotes would be a separate enrichment operation that identifies the receiving registrar and any credential requirements. The default enrichment policy is still open.

Proposed access is a structured CLI for coding agents and a local browser interface for Piyush, both using the same engine and result definitions. MCP and a local HTTP API remain possible integrations; neither has been selected. A UI should cover batch entry, filtering, shortlist review, purchase comparisons, progress, and exports without requiring terminal use for those tasks.

This scope produces a shortlist of names with no registry record and distinguishes indicative prices from live registrar quotes. It does not claim guaranteed registrability or protection against registry logging.

## Decisions still open

| Decision | Current proposal | What would resolve it |
| --- | --- | --- |
| Adopt, modify, or build an engine | Evaluate saidutt46/domain-check first | Validate routing, negative responses, rate limits, and batch behavior before selecting a foundation |
| Agent access | Structured CLI as the first adapter; MCP remains open | Decide whether coding agents need CLI, MCP, or both at launch |
| Human interface | A UI using the same engine | Agree on the minimum batch, shortlist, and purchase-comparison screens before design |
| Initial validation set | Several registry infrastructures and important ccTLDs, including .si | Agree on priority extensions without limiting automatic discovery to that list |
| WHOIS coverage | Add adapters with explicit registry-specific negative responses | Assess existing parser coverage and the maintenance effort |
| Privacy routing | Registry-only candidate requests during discovery | Review referrals, proxies, DNS requests, logs, and dependencies in the selected engine |
| Purchase information | Verified registrar links and published prices, with live quotes on request | Decide whether exact quotes are requested explicitly or fetched automatically for shortlisted names |
| Pricing comparison | Separate registration, renewal, premium fees, currency, and freshness | Decide the comparison period, supported currencies, and treatment of missing tax data |
| Registered domains for sale | Undecided | Decide whether aftermarket listings belong in the first version |
| Persistence | Local results with timestamps and resume | Choose files or a local database based on interface and history needs |
| Language and dependencies | Undecided | Let the engine and interface choice determine the smallest practical stack |

## Proposed engine evaluation

This is future work, not an executed test plan. Run it after Piyush agrees to the evaluation scope.

1. Record the selected repository commit, license, and version.
2. Inspect outbound routing to identify candidate disclosure to registries, registrars, aggregators, DNS resolvers, and telemetry.
3. Compare known registered names, reserved names, and inconclusive responses across representative registries. Use purpose-created low-value test names for negative lookups.
4. Verify that empty WHOIS responses, malformed JSON, mismatched domain records, timeouts, access denials, and unknown extensions cannot become positive availability results.
5. Check that shared registry pacing honors full Retry-After cooldowns and does not switch protocols merely to evade a rate limit.
6. Check multi-label public suffixes, internationalized names, deduplication, exports, cancellation, resume, and stale-result rechecks.
7. Choose adoption, a small modification, or a new engine based on observed gaps.

## Coverage reporting

Keep endpoint discovery separate from verified support. A coverage report should identify the lookup source and distinguish tested adapters, discovered but untested services, transient failures, and extensions with no supported public lookup. Missing bootstrap data alone must not be labeled proof that RDAP does not exist.

The approximately 84 percent HTTPS discovery figure in [the findings](FINDINGS.md) is a dated metadata comparison, not an acceptance criterion already met by this project.

## Proposed build readiness criteria

- Piyush explicitly authorizes implementation.
- The interface and engine approach are decided.
- Agent access and the minimum human UI are agreed.
- Result terminology and privacy routing are agreed.
- Registrar links and pricing scope are agreed.
- The initial validation set and acceptance checks are chosen.

## Planning history

| Date | Change |
| --- | --- |
| October 4, 2026 | Expanded the intended scope from .si to all feasible TLDs; researched existing tools and purchasing information |
| October 4, 2026 | Created Domain Scout to preserve findings and continue planning; no application implementation adopted |
| October 4, 2026 | Confirmed coding agents as the primary users and a UI for Piyush; expanded planning to pricing and purchase details; authorized a private repository |

## Repository visibility

The GitHub repository is private during planning and implementation. An end-to-end product may later be considered for open source. Completion alone does not authorize a visibility change or publication; licensing and release scope remain future decisions.
