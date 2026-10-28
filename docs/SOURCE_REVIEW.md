# Product source review

Reviewed October 5, 2026. This review combines 13 public repositories, official documentation for nine purchase providers, standards, and our local trial. It is a targeted source review, not an exhaustive survey of every existing solution.

Only WhiteBite Domain Hunter was installed and exercised through UI, CLI and MCP. Other project features below come from their documentation, with selected earlier source inspections noted in the reference map. No benchmark, accuracy claim or advertised coverage is adopted without validation. [Trial evidence](TRIAL.md), [implementation references](REFERENCES.md).

Public source snapshots are saved under the ignored `trials/research/2026-10-05/` directory. No candidate-domain queries, authenticated registrar calls or purchases were made during this follow-up review.

## Repositories and recent activity

Dates below are latest default-branch commit dates in UTC, not GitHub page-update dates. Each project link pins the reviewed README revision. All 13 repositories were unarchived when checked. A recent commit can be automation or housekeeping; it is not proof of ongoing support or protocol correctness.

| Project | Latest commit | Documented features | Interpretation |
| --- | --- | --- | --- |
| [WhiteBite/Domain-Hunter](https://github.com/WhiteBite/Domain-Hunter/blob/f16c6a2c3a77894ce0c9f25e6a9c0a3711afbdbb/README.md) | 2026-10-04 | Bulk jobs, resume, pricing, generation, shortlist, UI/CLI/MCP | Tested at an earlier pinned revision. Latest commit updates prices automatically; it does not establish a recent engine fix. |
| [saidutt46/domain-check](https://github.com/saidutt46/domain-check/blob/66aa04046ac966fa37a47224bb8af562281ecc65/README.md) | 2026-09-28 | Pattern expansion, CLI, Rust library and MCP | Useful agent and batch reference. Prior inspection found short-WHOIS-response and retry behavior needing review. |
| [jedarden/domain-check](https://github.com/jedarden/domain-check/blob/c137e60a171995bd3c05c2eeefecfb7ccded9640/README.md) | 2026-09-18 | Web/API/CLI, cached checks and domain watch | Latest commit is housekeeping. Advertised accuracy is not our measured result. |
| [knightsri/domain-checker](https://github.com/knightsri/domain-checker/blob/3a091d5d11c3298079961e72be02a607285212a1/README.md) | 2026-02-21 | Persistent scans, CSV, rechecks and responsive PWA | Useful history reference; latest default-branch commit is from February. |
| [PlayerYK/dmcheck](https://github.com/PlayerYK/dmcheck/blob/91870009a12a7bb98fa2b8260a57ef512187568c/README.md) | 2026-05-22 | Focused input, detail drawer, streamed results and separate provider modules | AGPL-3.0 source. Use design ideas; inspect licensing before code reuse. README API assumptions can become outdated. |
| [dorukardahan/domain-search-mcp](https://github.com/dorukardahan/domain-search-mcp/blob/d014d2115a4c5b41c3586c9e5de39376d6415edd/README.md) | 2026-07-29 | Agent tools, suggestions, optional pricing and cross-platform name checks | External checks broaden candidate disclosure. Documented claims of unlimited RDAP are not accepted. |
| [codeatlasdev/domain-hunter](https://github.com/codeatlasdev/domain-hunter/blob/3a2fde6d6de8d71b919ea57723ee88746133baeb/README.md) | 2026-09-10 | Broad registrar list including Hostinger, presets, generation and terminal interface | Provider count is not proof of live quotes. DNS absence and advertised scan speeds are not authoritative availability evidence. |
| [openrdap/rdap](https://github.com/openrdap/rdap/blob/64c8c7de5f0945ce8550086ee0edaeed46eacfaa/README.md) | 2026-09-23 | Endpoint discovery, cached bootstrap and structured RDAP output | Protocol reference, not a complete purchase-comparison product. |
| [zemse/domain-utils](https://github.com/zemse/domain-utils/blob/060a86b2028885fa96b18cd4e9679973bae42ec2/README.md) | 2026-06-06 | Opt-in attributed pricing, cache, diagnostics and expiry watch | Useful separation of enrichment from discovery; diagnostic queries add destinations. |
| [ricky9w/namestack-domains](https://github.com/ricky9w/namestack-domains/blob/eb5f6a8830c7b3f8758fb41c66ff5948a5e42988/README.md) | 2026-09-16 | Read-only registrar CLI/MCP, structured evidence and partial failures | Useful agent contract example. Provider-mediated checks differ from registry-only discovery; access scopes need validation. |
| [Rasaboun/dispo](https://github.com/Rasaboun/dispo/blob/7032806e6d8f062cd207b8921c52792e5b144269/README.md) | 2026-05-16 | stdin/files, name expansion, JSON output and configurable delay | Keep simple imports and pacing. Do not silently inherit its third-party fallback. |
| [weppos/whois-parser](https://github.com/weppos/whois-parser/blob/bedb4a48b0c9b28dad1c18e5d2bd0f761642927c/README.md) | 2022-09-08 | Registry-specific WHOIS response fixtures and parsers | Latest default-branch commit is from 2022. Historical fixture reference, not evidence of maintained current registry coverage. |
| [MarsHeer/agentdomain-mcp](https://github.com/MarsHeer/agentdomain-mcp/blob/89ea3d903e8ac669e2044cc56655bfc55f4e6008/README.md) | 2026-05-24 | Agent search, purchase and management workflows | Purchases, wallets and DNS changes are outside scope. README says MIT; a license file was not confirmed in this review. |

The Rust domain-check project provides MIT and Apache-2.0 license files despite GitHub reporting an unclassified license. dmcheck has an AGPL-3.0 license. Other GitHub license metadata is recorded in the local snapshots; check actual license files, copied material and notices before selecting dependencies or copying source. [Rust license files](https://github.com/saidutt46/domain-check/tree/66aa04046ac966fa37a47224bb8af562281ecc65), [dmcheck license](https://github.com/PlayerYK/dmcheck/blob/91870009a12a7bb98fa2b8260a57ef512187568c/LICENSE).

## Ideas to combine

| Product idea | References | Domain Scout proposal |
| --- | --- | --- |
| Recoverable bulk work | WhiteBite, knightsri, Rust domain-check, dispo | Import and validate lists, preview expansion, preserve partial work and resume with honest timestamps |
| Clear primary workflow with details on demand | dmcheck and our UI trial | Redesign scan, results, shortlist and comparison views; keep evidence available without crowding routine work |
| Broad providers with explicit capability levels | codeatlas, dmcheck and official provider docs | Separate links, catalogs, exact-name confirmation and quotes; Hostinger required, partial provider support useful |
| Pricing that helps a purchase decision | WhiteBite, domain-utils and registrar docs | Registration, renewal, required term, premium status, comparable ownership estimate, source and freshness |
| Predictable agent interfaces | Rust domain-check, Namestack, domain-search-mcp and our MCP trial | Non-interactive CLI/MCP, structured results, partial failures, inspectable jobs and essential UI feature parity |
| Control over extra disclosure | domain-utils and our outbound-request trial | Registry-only discovery; separately requested provider quotes and external checks |
| Candidate and shortlist expansion | WhiteBite, jedarden, domain-search-mcp | Include generation, saved searches and explicitly configured monitoring in the complete product scope |

These proposals combine features, user goals and trial gaps. They do not imply that every existing tool lacks those capabilities. In particular, Domain Hunter already offers export options, several result states, history, provider catalogs and generation. Our observed gaps were specific routing, default export behavior, link consistency, quote semantics and the desired UI/provider scope.

## Purchase-provider documentation

Nine providers were reviewed: Hostinger, Dynadot, Namecheap, GoDaddy, Porkbun, Cloudflare Registrar, Spaceship, NameSilo and Name.com. Their official links and documented capability differences are recorded in [the provider reference table](REFERENCES.md#purchase-provider-references). None is implemented in Domain Scout, and no authenticated quote was tested.

- Hostinger documents availability and a separate billing catalog. Their combination has not established an exact-name premium quote.
- Dynadot, Namecheap and GoDaddy document domain-specific availability/pricing fields with different account requirements.
- Current Porkbun documentation includes authenticated availability/pricing operations in addition to the public catalog exercised in our trial.
- Cloudflare now documents cached search and real-time availability/pricing APIs. Its official API is a stronger reference than the third-party catalog used in the trial.
- Spaceship documents availability and premium-pricing fields. NameSilo describes availability and price operations. Name.com distinguishes discovery/acquisition pricing from registration, renewal and transfer pricing.

Documentation establishes possible integration paths, not tested account access, complete renewal/tax information, supported extensions or a working adapter. Keep original currencies, term requirements, region, source dates and missing fields explicit. Do not automatically send candidates to these providers merely because their APIs exist.

## Standards and namespace references

- [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json) and [IANA WHOIS guidance](https://www.iana.org/help/whois) inform registry discovery. A discovered endpoint does not prove working coverage.
- [RDAP HTTP semantics](https://www.rfc-editor.org/rfc/rfc7480.html) describe responses and rate limits. Network failures and throttling are unresolved outcomes.
- [EPP domain checks](https://www.rfc-editor.org/rfc/rfc5731.html#section-3.1.1) illustrate the distinction between a registration-data lookup and provisioning availability.
- [Public Suffix List](https://publicsuffix.org/) informs boundaries such as `.co.uk`; private suffixes and registry restrictions still require separate handling.
- [Register.si registrar directory](https://www.register.si/en/registrars/) is a registry-published reference for purchase-provider coverage for `.si`.

## Our own recommendations

The requirement list adds measurable product expectations: a 1,000-domain acceptance workload, separately inspectable registry and provider evidence, explicit export scopes, matching price/provider destinations, comparable ownership estimates, and equivalent essential UI/agent behavior. These are our recommendations based on the desired workflow, not demonstrated Domain Scout capabilities.

Keep source-informed ideas as candidates rather than inheriting every feature. The complete product plan includes discovery, shortlisting, provider comparison and external checkout handoff, together with generation, monitoring, diagnostics, aftermarket discovery and cross-platform naming checks. At Piyush's request, the requirements are now a single scope without effort estimates or release phases.

The complete feature list and acceptance scenarios are in [PRODUCT.md](PRODUCT.md). Piyush selected Go CLI, NestJS backend and Next.js frontend, with macOS/Windows/Linux support and optional key-based integrations. The [build handoff](BUILD_HANDOFF.md) maps these references to the implementation plan. Visual design is intentionally excluded from this planning pass.
