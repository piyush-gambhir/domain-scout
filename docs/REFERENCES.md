# Implementation references

Updated October 5, 2026. This is a planning reference map, not a dependency list or implementation approval. Piyush chose an independently designed Domain Scout after trying Domain Hunter, with a complete UI redesign and broader purchase-provider support including Hostinger.

## Existing projects

| Area | Reference | What to learn or selectively reuse | Limits |
| --- | --- | --- | --- |
| Shared CLI, MCP, and UI behavior | [Domain Hunter, pinned revision](https://github.com/WhiteBite/Domain-Hunter/tree/7ef726280b5c8157b97d7637548909388a5008af) | Shared command contracts, structured results, bootstrap merging, provider catalogs, exports, cancellation | MIT; retain required notices for copied code. Do not inherit candidate disclosure, result classifications, cooldown limits, or the UI without review. See [trial evidence](TRIAL.md). |
| Bootstrap implementation | [Domain Hunter bootstrap](https://github.com/WhiteBite/Domain-Hunter/blob/7ef726280b5c8157b97d7637548909388a5008af/src/core/bootstrap.ts) | Endpoint discovery and merging curated exceptions | Discovery is not verified TLD coverage. |
| Batches and scheduling | [Domain Hunter queue](https://github.com/WhiteBite/Domain-Hunter/blob/7ef726280b5c8157b97d7637548909388a5008af/src/core/queue.ts) | Bounded work, progress, cancellation, infrastructure grouping | Review against full registry cooldowns and our result semantics before reuse. |
| Price comparison | [Domain Hunter pricing](https://github.com/WhiteBite/Domain-Hunter/blob/7ef726280b5c8157b97d7637548909388a5008af/src/pricing/pricing.ts) | Catalog adapters, minor currency units, separate registration and renewal values | Catalogs are not exact quotes; purchase links must correspond to the provider whose price is shown. |
| Machine interface | [Domain Hunter CLI contract](https://github.com/WhiteBite/Domain-Hunter/blob/7ef726280b5c8157b97d7637548909388a5008af/cli/contract.ts), [MCP tools](https://github.com/WhiteBite/Domain-Hunter/blob/7ef726280b5c8157b97d7637548909388a5008af/cli/mcp/server.ts) | Non-interactive operations and shared core behavior | Define our own stable result contract and separate registry checks from provider enrichment. |
| RDAP and WHOIS routing | [saidutt46/domain-check](https://github.com/saidutt46/domain-check), [OpenRDAP](https://github.com/openrdap/rdap) | Protocol clients, routing, transport and parsing ideas | Reference candidates, not selected foundations. Earlier research found unsafe short-response handling and fixed RDAP retry timing in the Rust tool. Recheck versions and licenses before adopting code. |
| WHOIS response examples | [weppos/whois-parser](https://github.com/weppos/whois-parser) | Registry-specific fixtures and explicit negative-response patterns | Do not assume one generic parser works for all registries. |

The pinned Domain Hunter checkout remains under `trials/domain-hunter/` for inspection. No upstream source has been changed. Other project links are research references and are not vendored dependencies. The broader [product source review](SOURCE_REVIEW.md) records 13 repositories, their reviewed revisions, latest default-branch commit dates, feature ideas and maintenance caveats.

## Protocol and namespace references

- [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json): authoritative endpoint discovery.
- [IANA WHOIS documentation](https://www.iana.org/help/whois): registry server referrals.
- [RDAP HTTP semantics, RFC 7480](https://www.rfc-editor.org/rfc/rfc7480.html): response handling and rate limits.
- [EPP domain check, RFC 5731](https://www.rfc-editor.org/rfc/rfc5731.html#section-3.1.1): why a public registration-data lookup and provisioning eligibility are different facts.
- [Public Suffix List](https://publicsuffix.org/): registration-boundary input, with registry policy and its private section handled separately.
- [Register.si registrar directory](https://www.register.si/en/registrars/): registry-published purchase-provider source for `.si`.

The protocol references were reviewed during the October 4 research. Endpoint discovery measurements are dated in [FINDINGS.md](FINDINGS.md) and must not become claims of tested support.

## Purchase-provider references

Provider support has distinct parts: extension support and purchase links, published prices, domain-specific availability confirmation, and quotes. Implementing one part does not establish that the others work.

| Provider | Official reference | Documented capability | Proposed treatment |
| --- | --- | --- | --- |
| Hostinger | [Domain catalog](https://www.hostinger.com/domains), [pricing help](https://www.hostinger.com/support/1583426-how-much-does-it-cost-to-register-a-new-domain-at-hostinger/) | Extension offerings and storefront prices; term and renewal information can require cart review | Required provider. Record region, currency, registration term, renewal, fees and freshness where available. |
| Hostinger | [Availability API](https://github.com/hostinger/api-python-sdk/blob/main/docs/DomainsAvailabilityApi.md), [response schema](https://github.com/hostinger/api-python-sdk/blob/main/docs/DomainsV1AvailabilityAvailabilityResource.md), [billing catalog API](https://github.com/hostinger/api-python-sdk/blob/main/docs/BillingCatalogApi.md), [authentication](https://docs.hostinger.com/api-reference/overview) | Authenticated availability checks and a separate authenticated service catalog | Optional token-based provider adapter. Availability plus a catalog entry is not a demonstrated exact premium quote. |
| Dynadot | [API commands](https://www.dynadot.com/domain/api-commands) | Authenticated search supports availability and optional price information | Candidate for domain-specific enrichment on request; provider access and behavior still need testing. |
| Namecheap | [Domain checks](https://www.namecheap.com/support/api/methods/domains/check/), [API introduction](https://www.namecheap.com/support/api/intro/) | Authenticated availability checks include premium fields; production API access has prerequisites | Candidate provider; show API requirements rather than assuming every account can quote. |
| GoDaddy | [Current API quickstart](https://developer.godaddy.com/en/docs/api-users/quickstart), [authentication](https://developer.godaddy.com/en/docs/api-users/auth) | Documented Domains v3 availability response includes pricing by term and uses a PAT | Candidate provider. Validate the current API and account permissions instead of copying legacy integration assumptions. |
| Porkbun | [API documentation](https://porkbun.com/api/json/v3/documentation) | Public standard-price catalog used in the trial; current documentation also describes authenticated availability/pricing operations | Candidate for optional exact-name enrichment. Authenticated operations have not been tested; catalog support remains separate. |
| Cloudflare Registrar | [Registrar API guide](https://developers.cloudflare.com/registrar/registrar-api/), [API reference](https://developers.cloudflare.com/api/resources/registrar/), [trial catalog evidence](TRIAL.md#purchase-options-and-prices) | Official APIs document cached search and real-time availability/pricing checks | Candidate for optional authenticated quotes. Trial prices came from `cfdomainpricing.com`, not these official APIs; verify account access, supported extensions and current API limits. |
| Spaceship | [API documentation](https://docs.spaceship.dev/) | Authenticated availability operations with premium-pricing fields | Additional provider candidate. Validate standard and renewal pricing before claiming full quote comparison. |
| NameSilo | [API manager](https://www.namesilo.com/support/v2/articles/account-options/api-manager) | Key-based API describes availability checks and price retrieval | Additional provider candidate. Verify exact-name quote behavior, premium handling and terms; provider API actions are logged. |
| Name.com | [Domain pricing](https://docs.name.com/guides/domain-pricing.md), [documentation index](https://docs.name.com/llms.txt) | Discovery/acquisition pricing and separate registration, renewal and transfer pricing roles | Additional provider candidate. Authenticated account access is required; distinguish aftermarket acquisition from new registration. |

Documentation for these nine providers was checked October 5, 2026. No candidate names, authenticated provider requests, cart submissions, or purchases were sent during this follow-up research. These are documented capabilities, not working Domain Scout integrations.

Hostinger's inspected availability schema has domain, availability, alternative, and restriction fields, without a price field. Its billing catalog documents service prices separately. Treat purchase links, optional authenticated availability and catalogs as distinct capabilities. Exact-name pricing still needs validation. Piyush currently has no registrar keys: keyless capabilities and optional console/CLI configuration are part of the finalized [handoff](BUILD_HANDOFF.md).

## Reuse boundary

Build our own user experience, provider model, result contract, and orchestration. Prefer maintained libraries for protocol transport, suffix handling, and agent interfaces once the stack is selected. Use existing applications as working examples and sources of test cases. Copy specific code only after inspecting it, confirming compatibility, and retaining required attribution. Do not carry an upstream dependency tree into Domain Scout merely to reuse its UI or one adapter.
