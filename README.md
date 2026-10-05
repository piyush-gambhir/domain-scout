# Domain Scout

Domain Scout is a planned local utility for checking domain registration records, finding purchase options, and comparing pricing and related details where reliable data is available. Coding agents are the primary users; Piyush will use a visual interface.

Status: product and engineering plan finalized for the coding agent, without effort estimates or release phases. Go CLI, NestJS backend and Next.js frontend are selected. API contracts, module boundaries, storage, commands, public references and verification are in the build handoff. Visual design is intentionally outside this planning pass. Application implementation has not started.

Execution: local NestJS backend, Next.js browser frontend, Go CLI and SQLite storage, targeting macOS, Windows and Linux. No hosted infrastructure is required. Registry checks and supported public information need no keys; optional authenticated providers can be configured in app settings or through the CLI. MCP may be added afterward.

Repository visibility: private. It should remain private during planning and implementation. Open sourcing may be considered after the complete workflow works, and requires a separate explicit decision.

The working name is Domain Scout. Its naming availability has not been checked.

## Project notes

- [Findings](FINDINGS.md): feasibility, measured discovery coverage, existing projects, purchase information, and sources.
- [Product requirements](PRODUCT.md): complete build scope, behavior defaults, UI and agent expectations, and acceptance scenarios.
- [Product source review](SOURCE_REVIEW.md): feature ideas from 13 repositories and nine providers, recent activity, evidence limits, and our recommendations.
- [Build handoff](BUILD_HANDOFF.md): start here for the next coding agent; contracts, modules, data, commands, public-project reference map and verification.
- [Plan](PLAN.md): complete product summary, local fundamentals, workflows, boundaries and final decisions.
- [Tech stack](TECH_STACK.md): selected Go/NestJS/Next.js technologies, supporting choices, sources and packaging tradeoffs.
- [Existing-solution trial](TRIAL.md): local UI, CLI, and MCP evaluation of WhiteBite Domain Hunter, including observed gaps.
- [Reference map](REFERENCES.md): existing code, protocol documentation, and provider APIs to inform our own product.
- [Agent instructions](AGENTS.md): boundaries for continuing this project.

An authorized trial of WhiteBite Domain Hunter is installed under `trials/`. Its UI, CLI, and MCP interface worked with public test domains. Piyush chose to make our own product using the references and lessons from this trial. We will design our own UI and provider workflow, and select reusable protocol components during planning.

## Existing scaffold

An untested Python scaffold was created earlier at `../domain-scanner/scanner.py` in the original local workspace, before the request to plan first. It remains outside this repository and has not been copied, modified, or adopted here.
