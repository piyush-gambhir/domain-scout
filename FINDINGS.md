# Domain availability research

Research date: October 4, 2026. These notes preserve the investigation conducted before implementation was approved. Documentation and selected source files were reviewed; the shortlisted tools were not installed or tested.

A local scanner can query registries directly, process large batches automatically, and export names with no registration record. Broad TLD discovery is already practical. Universal coverage, zero registry logging, and guaranteed registration at a stated price cannot be promised from public lookups alone.

## User goals

- Support all TLDs where a usable public registry lookup exists, including .si.
- Avoid registrar storefronts and paid aggregators during candidate discovery.
- Process hundreds or thousands of names without manual copy and paste.
- Run locally without paid query credits or required third-party API keys for discovery.
- Export a useful shortlist and show where a name could be purchased.
- Research existing tools and agree on the plan before building.

The original problem statement raised registrar front-running as a concern. This investigation did not establish that candidate searches routinely cause registration or price increases. Direct registry queries reduce the number of intermediaries receiving names, but do not establish zero risk.

## Feasibility and protocol limits

RDAP is a structured registration-data protocol over HTTP or HTTPS. IANA publishes a directory of registry endpoints, and ICANN requires gTLD registries and registrars to provide RDAP. Most gTLD WHOIS obligations ended on January 28, 2025, with specified exceptions. RDAP should therefore be the default discovery protocol. [ICANN RDAP information](https://www.icann.org/en/contracted-parties/registry-operators/registration-data-access-protocol/information-for-rdap-users-31-08-2018-en), [IANA RDAP directory](https://www.iana.org/assignments/rdap-dns).

WHOIS uses TCP port 43 and remains useful for extensions without a usable RDAP endpoint. IANA can return referrals to registry WHOIS servers. Discovering the correct server does not solve response parsing: different registries use different messages. [IANA WHOIS documentation](https://www.iana.org/help/whois).

Registry rate limits remain in force when querying directly. RDAP defines HTTP 429 and recommends reducing query rate and honoring Retry-After. High concurrency alone does not guarantee high throughput. A proposed scheduler should pace requests by registry infrastructure, since one host may serve many TLDs. [RFC 7480 rate limits](https://www.rfc-editor.org/rfc/rfc7480.html#section-5.5).

A browser can call RDAP when registry CORS behavior permits it. Browser code cannot directly open arbitrary TCP WHOIS connections. A local CLI or local process behind a browser interface is the proposed route to broader protocol coverage. RDAP recommends permissive CORS, which does not prove every endpoint implements it. [RFC 7480 CORS](https://www.rfc-editor.org/rfc/rfc7480.html#section-5.6).

Registries can observe and potentially log direct queries. WHOIS also sends names without transport encryption. The proposed privacy claim is that discovery sends candidates only to identified registry services, with no application telemetry. That routing and telemetry behavior would need verification.

## Measured discovery coverage

The live IANA root TLD list was compared with the RDAP bootstrap JSON in memory. No candidate-domain queries were required for this comparison.

| Measurement | Count |
| --- | ---: |
| TLDs in the root list | 1,437 |
| Root TLDs with any bootstrap endpoint | 1,203 |
| Root TLDs with an HTTPS bootstrap endpoint | 1,201 |
| Root TLDs with only HTTP endpoints | 2 |
| Root TLDs absent from the bootstrap directory | 234 |

HTTPS discovery covers approximately 83.6 percent of the listed TLDs. Root-list version: 2026100400, updated October 4, 2026 at 07:07:01 UTC. Bootstrap publication: September 30, 2026 at 23:00:03 UTC. Sources: [IANA root TLD list](https://data.iana.org/TLD/tlds-alpha-by-domain.txt), [IANA bootstrap JSON](https://data.iana.org/rdap/dns.json).

Method: lowercase the root names, collect unique suffixes from bootstrap services, and intersect the sets. The HTTPS count includes a suffix if any listed endpoint uses HTTPS. The inspected bootstrap contained no multi-label suffix entries.

These counts establish endpoint discovery only. They do not establish successful responses, CORS support, reliable negative answers, public registration eligibility, or tested scanner coverage. Missing bootstrap entries also do not prove a registry has no RDAP service elsewhere.

Examples present in the directory included .si, .ai, .com, .uk, .au, and .in. Examples absent included .io, .de, .cn, and .za. IANA separately lists whois.nic.io for .io. [IANA .io delegation](https://www.iana.org/domains/root/db/io.html).

## Domain names and availability semantics

Names such as example.co.uk and example.com.au require registration-boundary handling. Checking only two-label names would miss important namespaces; treating arbitrary subdomains as purchasable would create misleading results. The Public Suffix List is a useful input, with registry rules still determining eligibility. Its private section needs separate treatment because it includes services whose subdomains are not registry domain registrations. [Public Suffix List](https://publicsuffix.org/).

RDAP 404 means the server has no matching data. A missing registration record does not establish whether a name is reserved, restricted, priced as premium, or accepted for registration. Registration provisioning has separate protocol semantics: EPP check reports whether an object can be provisioned at that moment, subject to registry policy. [RFC 7480 negative responses](https://www.rfc-editor.org/rfc/rfc7480.html#section-5.3), [RFC 5731 check command](https://www.rfc-editor.org/rfc/rfc5731.html#section-3.1.1).

Missing DNS records cannot prove availability. Registered domain objects may be inactive without delegation information, or placed on hold. DNS can supply supporting evidence, but should not turn an inconclusive registry response into a guaranteed available result. [RFC 5731 domain statuses](https://www.rfc-editor.org/rfc/rfc5731.html#section-2.3).

Proposed output categories are registered, no registry record, inconclusive, rate limited, invalid, and unsupported. None imply confirmed checkout eligibility or a guaranteed price.

## Existing projects

The features below come from project documentation unless identified as source observations. Advertised coverage and speed have not been independently validated.

| Project | Relevant functionality | Assessment |
| --- | --- | --- |
| [saidutt46/domain-check](https://github.com/saidutt46/domain-check) | Rust CLI and library, RDAP discovery, WHOIS fallback, batch input, TLD expansion, JSON and CSV; advertised 1,200+ TLDs | Strongest candidate for an initial engine evaluation. Offers MIT or Apache-2.0 licensing. |
| [WhiteBite/Domain-Hunter](https://github.com/WhiteBite/Domain-Hunter) | Browser interface, bulk input, resume, exports, curated TLD support and automatic bootstrap discovery | Useful interface reference. Includes external aggregation and DNS fallbacks that do not meet a strict registry-only routing requirement. MIT licensed. |
| [jedarden/domain-check](https://github.com/jedarden/domain-check) | Go binary, CLI, web UI, API, bulk workflow, caching and registry concurrency controls | Candidate if a local browser interface is important. Documentation specifies a 50-domain HTTP bulk limit. MIT licensed. |
| [knightsri/domain-checker](https://github.com/knightsri/domain-checker) | FastAPI and React interface, RDAP checks, SQLite history, TLD expansion and CSV export | Useful workflow reference; its routing and classification were not audited. MIT licensed. |
| [OpenRDAP](https://github.com/openrdap/rdap) | Go RDAP client and library with bootstrap discovery and caching | Protocol foundation; additional batch and classification behavior would be needed. MIT licensed. |

### Source observations requiring review

The Rust tool's WHOIS parser treats certain unmatched responses shorter than 50 characters as available unless they contain a few error words. This is a possible false-positive path. Its inspected RDAP implementation retries a rate-limited query after a fixed 500 ms delay. These are reasons to validate and possibly modify the tool before adoption, not proof that all its results are unreliable. [WHOIS parser](https://github.com/saidutt46/domain-check/blob/main/domain-check-lib/src/protocols/whois.rs#L288), [RDAP retry](https://github.com/saidutt46/domain-check/blob/main/domain-check-lib/src/protocols/rdap.rs#L213).

Domain Hunter includes a Cloudflare RDAP aggregator and DNS corroboration. Its source also clamps Retry-After waits to 10 seconds. The external requests broaden who sees candidate names, and the retry handling needs review against longer registry cooldowns. [Domain Hunter RDAP client](https://github.com/WhiteBite/Domain-Hunter/blob/main/src/core/rdap-client.ts).

Sources were inspected on October 4, 2026 through mutable main-branch URLs. Record commit revisions during any future adoption evaluation so findings can be reproduced.

### Supporting libraries and references

- [weppos/whois-parser](https://github.com/weppos/whois-parser): MIT-licensed Ruby parsers and registry-specific response examples.
- [rfc1036/whois](https://github.com/rfc1036/whois): established WHOIS client and server-selection reference, GPL-2.0 licensed. Review licensing before reusing code.
- [jakejarvis/rdapper](https://github.com/jakejarvis/rdapper): Node RDAP and WHOIS client with custom bootstrap-data support.

## Purchase information

Registry discovery and purchasing information are separate. An unregistered name generally has no single assigned seller. A registrar that supports the extension may register it, subject to eligibility and registry acceptance.

For .si, the registry publishes an official registrar list. A proposed directory could map extensions to verified registrar websites and purchase-search link templates without sending candidate names during discovery. [Register.si registrar directory](https://www.register.si/en/registrars/).

Published registration and renewal prices describe standard names. Premium names can have different prices. Exact domain pricing needs a registrar-specific query or checkout confirmation; Porkbun is one example with documented availability and pricing endpoints. Such queries disclose the candidate to that registrar and may require credentials. [Porkbun premium-domain explanation](https://kb.porkbun.com/article/41-what-is-a-premium-domain), [Porkbun API documentation](https://porkbun.com/api/json/v3/documentation).

The proposed first version would show verified providers and purchase links, with prices explicitly unverified. Exact price comparison remains an open scope decision. Constructing a link locally does not submit a search; following a link containing the domain reveals it to the destination.

## What was verified

- The IANA coverage comparison and listed example endpoints were read live.
- An earlier direct request for arnes.si returned a matching domain record from the official .si RDAP service.
- Project documentation, repository metadata, and selected implementation files were read.

No large batches, unregistered-name cases, comparative accuracy benchmarks, browser CORS behavior, end-to-end purchase flows, or full TLD coverage were tested. No shortlisted tool was installed. No registrar received a candidate during this research.

