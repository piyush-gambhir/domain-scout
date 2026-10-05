# Existing-solution trial: Domain Hunter

Trial performed October 4, 2026 UTC (October 4-5 in Asia/Kolkata).

## Verdict

WhiteBite Domain Hunter works locally through its UI, JSON CLI, and MCP server. It already covers enough of the intended workflow to continue trying it before deciding to build Domain Scout. This trial does not authorize a custom implementation or establish adoption of upstream.

It does not satisfy the original direct-registry-only goal by default. It also does not provide guaranteed registrability or universally confirmed domain-specific prices. A small modification may eventually be worthwhile, but these findings do not justify a fresh implementation yet.

## What was installed

- Upstream: [WhiteBite/Domain-Hunter](https://github.com/WhiteBite/Domain-Hunter), MIT license, package version `2.0.0`.
- Pinned code revision: [7ef726280b5c8157b97d7637548909388a5008af](https://github.com/WhiteBite/Domain-Hunter/tree/7ef726280b5c8157b97d7637548909388a5008af).
- Checkout: `trials/domain-hunter/`. Its source and lockfile remain unchanged.
- Dependencies installed locally with `npm ci --ignore-scripts`; npm cache is in `trials/runtime/npm-cache/`.
- Node `26.5.0`, npm `12.0.1`. Chrome was used for UI verification.
- Local browser tooling: `trials/browser-tools/`. Browser profile: `trials/runtime/chrome-profile/`.
- CLI state is redirected to `trials/runtime/app-home/` by `trials/local-state.cjs`. This launcher also records fetch destinations in `trials/artifacts/cli-network.jsonl`.
- `trials/mcp-smoke.mjs` is an evaluation harness, not Domain Scout application code. No MCP server was added to global agent settings.

The upstream checkout, installed packages, evaluation harnesses, app state, browser profile, and saved artifacts are contained in this project. `trials/` is ignored by the planning repository. No commits, pushes, deployments, purchases, or visibility changes were made during this trial.

The code is pinned, but upstream fetches current TLD configuration, IANA bootstrap data, and price data at runtime. Results are not an entirely frozen snapshot.

## Checks performed

| Check | Observed result |
| --- | --- |
| TypeScript and Svelte checks | Passed, zero errors and warnings |
| Focused existing tests | 5 files, 54 tests passed |
| CLI and MCP builds | Passed |
| UI production build | Passed, single HTML file about 1 MB |
| Live CLI batch | 5 domains checked, 4 taken, 1 probably available, no error or unknown rows |
| Live UI batch | 3 domains checked, 2 taken, 1 likely available |
| UI filtering | Available filter showed the synthetic candidate only |
| CSV export | Downloaded successfully; default export included all 3 results despite the view filter |
| Price comparison UI | Loaded and showed registrar columns and renewal information |
| MCP handshake and tool discovery | Passed, 5 tools exposed |
| MCP pricing and availability calls | Passed; both public domains returned taken |
| Browser errors | None reported during these interactions |
| TLD discovery | 1,211 loaded entries; endpoint discovery, not verified working or publicly registrable coverage |

Focused tests covered CLI storage, configuration data, name generation, bootstrap merging, and live-pricing parsing. This was a small functional trial, not a thousands-domain throughput test or an audit of all TLDs.

## Availability results

Only public test names and one synthetic, low-value name were checked. No private brand shortlist was used.

| Domain | CLI status | CLI source |
| --- | --- | --- |
| `example.com` | `taken` | RDAP |
| `google.com` | `taken` | RDAP |
| `arnes.si` | `taken` | RDAP |
| `bbc.co.uk` | `taken` | RDAP |
| `domain-scout-trial-20261004-a7c9.si` | `probably_available` | DoH |

The CLI reported 13.748 seconds for the batch with pricing enabled. This includes data loading and does not establish a general scanning speed. The UI used `example.com`, `arnes.si`, and the synthetic `.si` name, reporting the same classifications in about 2 seconds with data already loaded.

For the synthetic `.si` name, the request log shows an authoritative registry 404, a Cloudflare RDAP 404, and a Cloudflare DNS query. Upstream still returned `probably_available`. That is an observed confidence label, not a confirmation that checkout will succeed.

## Purchase options and prices

The tool returned first-year and renewal catalog prices and registrar search links. The synthetic `.si` row displayed Dynadot at **$12.05 first year** and **$13.51 renewal**, labeled as snapshot data in the UI. The comparison view also listed Porkbun and Beget. These are values observed in this trial, not verified offers or recommendations.

The ordinary prices are TLD-level catalog values. They do not establish eligibility, premium pricing, taxes, minimum registration terms, account-specific promotions, or final checkout totals for a particular name.

An optional UI premium check sent the synthetic name to DigMyName. Its HTTP 200 response claimed `available: true`, but supplied no premium price and no cheapest registrar. The row continued to show its catalog estimate. This call demonstrates an additional source, not confirmation by a registrar or a completed purchase. The five exposed MCP tools do not include this UI detail check as a dedicated tool.

Purchase links are search destinations. The exported `example.com` row listed Cloudflare as the cheapest registrar while its buy URL pointed to Dynadot. This happened on a taken-domain test row, so purchase-link consistency for a real available shortlist still needs review.

## Privacy observations

The CLI network log directly recorded these destinations:

- Registry RDAP: Verisign, Nominet, and Register.si received the relevant domain names.
- Cloudflare DNS and Cloudflare RDAP received the synthetic candidate name.
- IANA and upstream GitHub supplied bootstrap and configuration data.
- Porkbun's public pricing endpoint and `cfdomainpricing.com` supplied catalog data without a candidate name in the request URL.

The optional UI premium action additionally sent the synthetic name to `api.digmyname.com`. Registrar purchase links were inspected without opening them.

The browser HAR captures page-level activity and is not a complete log of worker traffic. The CLI fetch log is the evidence for the scanner destinations listed above. No claim of zero logging or zero front-running risk follows from this trial.

## Remaining gaps before adopting or modifying it

1. Decide whether candidate names may go to Cloudflare or DigMyName. Strict registry-only checking would need a supported configuration or a small source change, with uncertain results preserved.
2. Confirm shortlisted names and their actual prices through explicitly selected registrars. Catalog prices and search URLs alone do not answer where a name is confirmed purchasable.
3. Verify broader coverage, especially ccTLDs, restricted TLDs, multi-label suffixes, unsupported RDAP, and WHOIS fallback needs. The successful `bbc.co.uk` lookup does not validate general suffix handling or pricing.
4. Test a representative batch size with respectful registry pacing before relying on large runs. The CLI documents a 3,000-name input limit; this trial checked five.
5. Review exports and purchase-link behavior. Keep `probably_available` separate from stronger evidence, and do not assume filtering the UI limits the default export.
6. Address dependency maintenance before distributing or adopting a fork. `npm audit` reported 12 findings: 7 high, 5 moderate, 0 critical. Direct findings included `vite-plugin-singlefile` (high) and `vitest` (moderate). These counts are not proof of an exploitable scanner vulnerability. Packages were left unchanged.

## Try it locally

The preview server was left running at [http://127.0.0.1:4173](http://127.0.0.1:4173). If it has stopped, restart it from the repository root:

```sh
cd trials/domain-hunter
npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
```

Run the existing CLI with project-local state, from the repository root:

```sh
cd trials/domain-hunter
node --require ../local-state.cjs dist-cli/domain-hunter.mjs check example.com arnes.si --no-cache
node --require ../local-state.cjs dist-cli/domain-hunter.mjs prices --tlds com,si,ai
```

Repeat the MCP evaluation from the repository root:

```sh
node trials/mcp-smoke.mjs
```

The UI and CLI make real network queries. Use the test names above while reviewing privacy behavior. Further checks can reveal candidate names to the destinations described above.

## Local evidence

- Availability JSON: [CLI results](trials/artifacts/cli-check.json).
- Price data: [CLI prices](trials/artifacts/cli-prices.json).
- Request destinations: [CLI network log](trials/artifacts/cli-network.jsonl).
- Agent interface: [MCP results](trials/artifacts/mcp-smoke.json).
- Optional detail API: [DigMyName response](trials/artifacts/ui-premium-response.json).
- Export: [UI CSV](trials/artifacts/ui-export.csv).
- Screenshots: [results](trials/artifacts/ui-results.png), [price comparison](trials/artifacts/ui-prices.png).
- Dependency findings: [npm audit](trials/artifacts/npm-audit.json).

These artifacts are local and ignored by Git. This report remains in the planning repository as an uncommitted document.
