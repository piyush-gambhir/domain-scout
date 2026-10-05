# Domain Scout instructions

This project is in research and planning. Piyush asked to save the findings and continue planning until explicitly deciding to build.

Piyush chose our own product after the trial, with a complete UI redesign and broader purchase-provider coverage including Hostinger. PRODUCT.md records the complete scope without estimates or release phases. The stack is finalized: Go CLI, NestJS backend, Next.js frontend. BUILD_HANDOFF.md is ready for the next coding agent. Visual design was explicitly excluded from this planning pass; do not treat a missing layout choice as an unanswered product/stack question.

- Research and update planning documents within the requested scope.
- Do not implement application code, install project dependencies, or adopt the earlier scaffold until Piyush explicitly authorizes building.
- Piyush authorized trying an existing solution inside this project. Upstream code, local dependencies, evaluation harnesses, runtime state, and artifacts may live under the ignored `trials/` directory. This exception does not authorize implementing Domain Scout or changing upstream source.
- Go, NestJS and Next.js are user-selected. TECH_STACK.md distinguishes these from supporting engineering defaults, including Express, SQLite, OpenAPI/SSE and Cobra. Cobra is not a user mandate.
- Read BUILD_HANDOFF.md, PRODUCT.md, TECH_STACK.md and REFERENCES.md before implementing. A later explicit instruction from Piyush to start building supersedes this planning-only restriction; do not request redundant stack/scope approval.
- Coding agents are the primary consumers; preserve structured, non-interactive workflows in the plan. Piyush also needs a UI using the same underlying behavior.
- Local execution targets macOS, Windows and Linux: Nest owns jobs/data, Next serves the frontend and calls Nest, Go calls the same API. No hosted infrastructure required. MCP is optional afterward, never a second engine.
- Piyush has no registrar API keys now. Build keyless registry/public capabilities and optional key-based integrations configurable in the UI console/settings and CLI. Never require registrar keys for discovery or claim fixture tests are live validation.
- Plan availability checks, purchase options, and pricing as distinct capabilities with explicit sources and freshness.
- Keep this GitHub repository private during planning and implementation. Do not make it public without a separate explicit instruction, even after the product is complete.
- Keep sourced findings separate from project claims and unverified hypotheses.
- Record source links, research dates, and the limits of any coverage measurement.
- Do not equate absent DNS or registration records with guaranteed registration eligibility or price.
- Do not send candidate names to registrars, aggregators, or DNS services as part of planning unless explicitly requested.
- Do not commit, push, publish, deploy, or change files outside this project unless requested.
- Piyush authorized creating a private GitHub repository and uploading these planning documents. That authorization does not authorize application implementation or deployment.
- Do not use em dashes.
