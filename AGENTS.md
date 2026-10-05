# Domain Scout instructions

Piyush authorized building on October 5, 2026. Implement inside this repo following BUILD_HANDOFF.md, PRODUCT.md, TECH_STACK.md, REFERENCES.md and docs/IMPLEMENTATION.md (monorepo layout, module ownership, contracts and conventions).

Piyush chose our own product after the trial, with a complete UI redesign and broader purchase-provider coverage including Hostinger. PRODUCT.md records the complete scope without estimates or release phases. The stack is finalized: Go CLI, NestJS backend, Next.js frontend. Visual design decisions made at build start are recorded below.

- Build the application in the Turborepo + pnpm monorepo (apps/backend, apps/web, apps/cli, packages/contracts, packages/api-client). Do not adopt the earlier Python scaffold.
- Git: commit milestones locally on the `build` branch. Do not push until Piyush says so.
- Live network checks during development are limited to a fixed test set: example.com, google.com, nic.si, bbc.co.uk and random 24-character gibberish names, sent only to registry RDAP/WHOIS, keyless public catalogs (IANA bootstrap, Porkbun pricing) and the optional DNS/TLS/GitHub/npm checks. No registrar or aggregator calls.
- UI: borderless and minimal (whitespace and soft tints instead of borders), monochrome accent, collapsible icon + label sidebar, domain details in a right-side panel.
- Piyush authorized trying an existing solution inside this project. Upstream code, local dependencies, evaluation harnesses, runtime state, and artifacts may live under the ignored `trials/` directory. Trial code is a reference only (Domain Hunter is MIT; keep notices for anything copied). Do not change upstream source.
- Go, NestJS and Next.js are user-selected. TECH_STACK.md distinguishes these from supporting engineering defaults, including Express, SQLite, OpenAPI/SSE and Cobra. Cobra is not a user mandate.
- Read BUILD_HANDOFF.md, PRODUCT.md, TECH_STACK.md, REFERENCES.md and docs/IMPLEMENTATION.md before implementing. Do not request redundant stack/scope approval.
- Coding agents are the primary consumers; preserve structured, non-interactive workflows in the plan. Piyush also needs a UI using the same underlying behavior.
- Local execution targets macOS, Windows and Linux: Nest owns jobs/data, Next serves the frontend and calls Nest, Go calls the same API. No hosted infrastructure required. MCP is optional afterward, never a second engine.
- Piyush has no registrar API keys now. Build keyless registry/public capabilities and optional key-based integrations configurable in the UI console/settings and CLI. Never require registrar keys for discovery or claim fixture tests are live validation.
- Plan availability checks, purchase options, and pricing as distinct capabilities with explicit sources and freshness.
- Keep this GitHub repository private during planning and implementation. Do not make it public without a separate explicit instruction, even after the product is complete.
- Keep sourced findings separate from project claims and unverified hypotheses.
- Record source links, research dates, and the limits of any coverage measurement.
- Do not equate absent DNS or registration records with guaranteed registration eligibility or price.
- Do not send candidate names to registrars, aggregators, or DNS services outside the fixed live test set above unless explicitly requested.
- Do not commit, push, publish, deploy, or change files outside this project unless requested.
- Piyush authorized creating a private GitHub repository. That does not authorize pushing build commits, publishing or deployment.
- Do not use em dashes.
