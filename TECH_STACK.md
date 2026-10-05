# Domain Scout tech stack

Updated October 5, 2026. Piyush selected **Go for the CLI, NestJS for the backend, and Next.js for the frontend**. Next.js calls NestJS. All application processes and persistent data run locally. This replaces the earlier TypeScript CLI and React/Vite recommendation.

The supporting choices below are engineering defaults for the handoff, rather than additional user mandates. Pin compatible package versions when implementing. No application dependencies have been installed and no application code has been written. [PRODUCT.md](PRODUCT.md) retains the complete scope; [BUILD_HANDOFF.md](BUILD_HANDOFF.md) specifies contracts, local lifecycle, storage, commands and verification without effort estimates or release phases.

## Selected technologies

| Area | Choice | Reason and constraints |
| --- | --- | --- |
| Agent CLI | Go | Compiled CLI consistent with Piyush's existing tools; standard HTTP client calls Nest. No second scanner or database. [Documentation](https://go.dev/doc/) |
| CLI parser | Cobra as a supporting default | Consistent command-tree help, flags and completion. Adds a dependency and boilerplate; Go flag is smaller but needs more manual subcommand handling. Piyush explicitly said Cobra is not required. [Cobra](https://github.com/spf13/cobra), [flag](https://pkg.go.dev/flag) |
| Backend | NestJS and strict TypeScript | Modules, dependency injection and testable services for the domain/provider/job workflow. [Nest providers](https://docs.nestjs.com/fundamentals/custom-providers), [strict checking](https://www.typescriptlang.org/tsconfig/strict.html) |
| HTTP adapter | Express, revised recommendation | Nest's default and consistent with Piyush's existing Nest projects; fewer integration differences. [Adapter documentation](https://docs.nestjs.com/techniques/performance) |
| JavaScript runtime | Node.js 24 LTS, compatible current patch | Local networking, timers and processes; use the same supported runtime for Next. [Release table](https://nodejs.org/en/about/previous-releases) |
| Frontend | Next.js App Router, React and TypeScript | Dedicated local browser application. Separate local Next server is the handoff default. [Self-hosting](https://nextjs.org/docs/app/guides/self-hosting) |
| Components | Tailwind CSS and shadcn/ui | Customizable, locally owned controls; visual design is intentionally outside this planning pass. [Next installation](https://ui.shadcn.com/docs/installation/next) |
| Client data | TanStack Query | Backend queries/mutations and cache invalidation from job events. [Documentation](https://tanstack.com/query/latest/docs/framework/react/overview) |
| Large tables | TanStack Table and TanStack Virtual | Bounded rendering with backend filtering/pagination for complete datasets. [Table](https://tanstack.com/table/v8/docs/introduction), [Virtual](https://tanstack.com/virtual/latest/docs/introduction) |
| Public schemas | Zod with nestjs-zod | Shared runtime validation and Nest DTOs; verify pinned adapter compatibility. [Zod](https://zod.dev/), [Nest integration](https://github.com/BenLorantfy/nestjs-zod) |
| Public API | REST /api/v1, OpenAPI 3.0 and SSE | Cross-language contract and resumable progress. [OpenAPI](https://docs.nestjs.com/openapi/introduction), [SSE](https://docs.nestjs.com/techniques/server-sent-events) |
| Go API client | oapi-codegen | Generate types/client from committed OpenAPI; verify drift. [Project](https://github.com/oapi-codegen/oapi-codegen) |
| Database | SQLite with better-sqlite3 | Backend-owned persistence without a DB server; prepared SQL and versioned migrations. [SQLite fit](https://www.sqlite.org/whentouse.html), [driver](https://github.com/WiseLibs/better-sqlite3) |
| Money | Decimal strings and exact decimal arithmetic | Preserve precision/currency; null means unknown. Pin a maintained decimal library during implementation. |
| Jobs and watches | Nest services, bounded workers and durable SQLite state | Shared source budgets across jobs, retries and watches; no Redis or separate queue service. |
| Registry transport | Node fetch and node:net | Direct HTTPS RDAP and TCP WHOIS with explicit routing, bounds and timeouts. [Networking](https://nodejs.org/api/net.html) |
| Namespace parsing | tldts and Node domainToASCII | Suffix/IDN helpers supplemented by verified registration rules. [tldts](https://github.com/remusao/tldts), [IDN conversion](https://nodejs.org/docs/latest-v24.x/api/url.html#urldomaintoasciidomain) |
| Integrations | Capability-specific TypeScript adapters in Nest | Official registry/provider/service interfaces and honest unsupported states. [References](REFERENCES.md) |
| Optional MCP | Official TypeScript SDK, local stdio adapter | Calls existing API; confirm supported SDK line when requested. [SDK](https://ts.sdk.modelcontextprotocol.io/) |
| Verification | Jest, Nest testing utilities, Next Jest integration, Playwright and Go tests | Focused contracts/services plus browser/CLI integration. [Nest testing](https://docs.nestjs.com/fundamentals/testing), [Next Jest](https://nextjs.org/docs/app/guides/testing/jest), [Playwright](https://playwright.dev/docs/intro) |
| Repository tooling | npm workspaces and a separate Go module | Committed npm lockfile and go.sum, explicit language boundaries. [Workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/) |

## Express versus Fastify

Both work with Nest. Nest documents Fastify's throughput advantage and warns that Express-specific integrations may need replacements with Fastify. Express is the default and has a broad middleware ecosystem. [Official comparison](https://docs.nestjs.com/techniques/performance).

For Domain Scout, the expectation that registry pacing and external network waits dominate HTTP overhead is an architectural judgment, not a measured benchmark. The local API submits jobs, retrieves persisted results and streams progress. Express offers the simpler default and matches Piyush's existing Nest backends. This revises the earlier Fastify recommendation after considering the workload and existing projects.

Neither adapter removes registry rate limits. Bound network concurrency, keep SQL transactions short and prevent long work from blocking API requests.

## Next runtime and backend boundary

Run Next and Nest as separate local servers, managed by one launcher when opening the UI. Go needs only Nest. This is the concrete handoff interpretation of Piyush's frontend-calls-backend clarification, rather than a further approval request.

Next renders presentation and forwards /api/v1 to Nest for same-origin browser access. It owns no scanner, provider integration, scheduler or SQLite state. Forward SSE without buffering. Viewing or server-rendering a page must not initiate a domain check or quote.

A static export is possible but is not the selected default; it limits dynamic routing and server features. A local Next server needs no Vercel deployment or paid hosting. [Self-hosting](https://nextjs.org/docs/app/guides/self-hosting), [static-export restrictions](https://nextjs.org/docs/app/guides/static-exports).

## Cross-language contracts

Go cannot import TypeScript types. Export Nest's validated public schemas as OpenAPI 3.0, then generate the Go types/client. The frontend uses the shared TypeScript schemas and a small API client. Contract changes must update the schema, generated client and consumer checks together.

SSE payloads follow the same public schemas. The CLI needs a tested stream reader for replay/reconnect semantics beyond ordinary generated REST methods. Stable event IDs and polling fallback are defined in [the handoff](BUILD_HANDOFF.md#api-and-events).

## Local distribution

The full app requires Node. A Go binary alone does not embed the Nest/Next application. Distribute compiled backend code, built Next assets/server, migrations, metadata and CLI with a versioned layout manifest. Provide a repository setup/run path without global installs. The CLI locates backend assets and reports a clear setup error if missing; it never silently downloads dependencies during an agent command.

better-sqlite3 includes native components. Verify the selected driver/Node combination for every supported OS/architecture, and retain native assets in distribution. Use WAL, indexed reads, short transactions and bounded exports; deletion and shutdown must respect active WAL state. [Driver installation](https://github.com/WiseLibs/better-sqlite3#installation), [SQLite WAL](https://www.sqlite.org/wal.html).

Packaged OS coverage is user-selected: macOS, Windows and Linux. Visual design is intentionally outside this planning pass. No registrar keys are available now: supported public capabilities work without them, and the console/settings plus CLI provide optional integration configuration. Authenticated live validation remains unverified until access is supplied. Research does not establish successful packaging or working integrations.
