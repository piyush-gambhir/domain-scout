# Domain Scout product requirements

Status: planning. This document records Piyush's intended workflow and proposed behavior. It does not authorize implementation. Research evidence and limitations are in [the findings](FINDINGS.md); implementation choices remain in [the plan](PLAN.md).

## Intended users

Coding agents are the primary consumers. They need a non-interactive interface with machine-readable results, predictable errors, and a way to complete large batches without parsing human-oriented screens. Piyush will use a UI for the same checks, shortlist review, pricing comparisons, and exports.

Both interfaces should use the same underlying checks and result definitions. A CLI, MCP integration, local HTTP API, and library are possible access mechanisms. The minimum combination has not been selected.

## Availability checks

The first capability answers whether a registry returns a registration record for the domain. It should support all feasible TLDs through discovery and verified adapters, report limits explicitly, and distinguish registered, no registry record, inconclusive, rate limited, invalid, and unsupported results.

Each result should carry its source, protocol, check time, and reason. An absent record must not be presented as confirmed checkout eligibility. Network errors, malformed responses, absent DNS, and unsupported namespaces must not produce positive availability claims.

The proposed discovery mode sends candidate names only to identified registry services. Candidate disclosure to other services must be visible and tied to a separate requested operation. This is a proposed product policy, not a promise that registries do not log requests.

## Purchase options

The second capability answers which providers offer the relevant extension and how to begin registration. Registrar support for an extension, a live quote for a particular domain, and successful registration are separate facts.

Proposed purchase-option fields are provider name, supported extension, registration link, provider-information source, verification time, and whether the domain has actually been quoted by that provider. Provider links should be useful without implying confirmed domain availability.

A registrar directory should prefer registry-published lists where available. Its coverage can be incomplete and should be described as such. Results should not silently equate a missing provider entry with an unavailable domain.

Following a provider link containing the domain sends that name to the provider. Generating the link locally does not require a search request. Automatic registration, cart submission, or payment is outside the currently requested scope.

Registered domains may also appear for sale through marketplaces. Aftermarket support remains an open decision because a listing needs separate verification and is different from registering an unregistered name.

## Pricing and related details

Piyush wants pricing and other useful details where obtainable. The plan should distinguish published standard extension prices from live domain-specific quotes. Exact quotes can disclose candidate names to providers and may require API credentials, even though registry discovery can remain free of API keys.

Proposed price fields are:

- Initial registration price and term.
- Renewal price and term.
- Currency, known taxes, and mandatory fees; missing tax or fee information remains explicit.
- Premium status when confirmed, including whether premium renewal pricing applies.
- Promotion conditions and the date or time the quote was obtained.
- Source and price type: published standard price, indicative estimate, or live domain quote.
- Transfer price when relevant and available.

Useful related fields may include registration restrictions, public registration dates and statuses for taken names, and nameservers. These depend on the registry response and do not imply complete access to holder details.

Missing values should remain missing, with a reason when known. Failed quote requests should not erase a successful registry result. Comparing cheapest providers requires equivalent terms, currencies, and treatment of fees; the comparison rule remains undecided.

The proposed default is published standard prices with live quotes on request. Piyush has not yet selected that default or automatic quoting for shortlisted names. No registrar quotes are authorized during the current planning phase.

## Bulk workflows

Bulk search is a core requirement. Proposed behavior includes complete-domain lists, expansion of base names across selected extensions, deduplication, validation, bounded concurrency, per-registry pacing, visible progress, cancellation, and recovery of completed results.

Agents and the UI should be able to filter results, collect a shortlist, recheck selected names, request purchase information for selected names, and export TXT, CSV, or JSON. Large batches should return partial successes while keeping errors distinguishable and retryable.

Resume should preserve the original check time. Reused results must remain distinguishable from fresh checks, and shortlisted names should have an explicit refresh path before purchase. Batch-size limits and performance targets are not yet chosen.

## Agent workflows

Proposed agent operations are checking a name or batch, expanding names across extensions, inspecting supported coverage, filtering a shortlist, finding providers, requesting prices, and exporting results. These are conceptual operations; command names, MCP tools, and API routes are undecided.

Agent responses should be structured and stable, preserve per-domain errors, identify cached data and freshness, and communicate which services would receive a candidate during enrichment. Machine output and progress messages should be separable. Authentication and credentials for optional pricing adapters need a design that avoids exposing secrets in results or logs.

An agent should be able to request registry-only discovery without automatic quote enrichment. Pricing functionality should not be required to complete the availability workflow.

## Human interface

The UI should let Piyush enter or import lists, choose extensions, start and stop scans, inspect progress, filter results, save a shortlist, compare providers and prices, and export the selected results. Source, freshness, and uncertainty should be visible where they affect purchase decisions.

No screen designs or frontend framework have been selected. Labeled design options should precede editing real UI components, following the workspace instructions.

## Example workflow

1. An agent or Piyush supplies candidate names and selected extensions.
2. Domain Scout checks registry records and returns results with evidence and timestamps.
3. The user filters a shortlist of names with no registry record.
4. Domain Scout shows registrars offering those extensions and any published price information.
5. If requested under the selected enrichment policy, it asks chosen registrars for domain-specific quotes.
6. The user rechecks and follows a purchase link. Final eligibility and price are confirmed by the registrar.

The same workflow should be possible through agent access and the human UI. Scope, interface choices, price policy, and validation criteria must be finalized before building.
