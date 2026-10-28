# Contributing

Use Node.js 26 (`.nvmrc`), pnpm 12 (the `packageManager` version in `package.json`) and Go 1.27 (toolchain in
`apps/cli/go.mod`). Docker is only needed for the container checks. From the repository root:

```bash
pnpm install
pnpm dev          # backend and web UI in watch mode; data in .dev-data
pnpm check        # lint, typecheck and unit tests for every workspace, Go included
pnpm build
pnpm test:e2e     # Playwright against a built backend and web server
pnpm acceptance   # 1,200 names against a local stub registry
pnpm generate     # after contract changes: openapi.json and the Go client
```

CI also runs Staticcheck, govulncheck and `go test -race` (from `apps/cli`), the tests on macOS and Windows,
the npm package install on every platform (`scripts/package-npm.mjs`, then `scripts/verify-npm-package.mjs`),
a Linux release archive (`scripts/package.mjs`, `scripts/verify-linux-package.sh`) and the Docker image
(`scripts/verify-docker-image.sh`).

## Rules

- Every capability is an API route first (`packages/contracts`), then a CLI command, MCP tool or UI screen.
  See "Clients and the API" in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md), which also lists module
  ownership and conventions.
- Tests use fixtures, fake transports or local servers. Live checks (`pnpm smoke`, `test:live`) are limited to
  example.com, google.com, nic.si, bbc.co.uk and random 24-character names, sent only to registry RDAP and
  WHOIS, keyless public catalogs and the optional DNS, TLS, GitHub and npm checks. Never send other names to
  registrars or aggregators from a test.
- Fixtures stay synthetic or redacted: no real registrant contact data. Record the source and license of
  anything derived from another project in the fixture's `provenance`.
- Never commit API keys, tokens, `api-token` files, session cookies or data directories.
- No registry result is a promise: keep "no record" distinct from "available", and prices tied to their
  source, type and age.

Submit changes through a pull request to `main`. Commits must be signed. The default branch requires linear
history, resolved review threads and passing CI and CodeQL checks.

## Dependency maintenance

Prefer current stable releases, with GitHub Actions pinned to commit SHAs. Dependabot checks Go modules and
Actions daily and npm packages weekly, grouping minor and patch updates per ecosystem; those merge
automatically once checks pass, and major updates wait for review. Node.js (`.nvmrc`, `Dockerfile`), pnpm and
the Go toolchain are updated by hand; keep `TECH_STACK.md` in step.

## Releases

Nothing is published yet: no npm packages, container images or GitHub releases. `scripts/package.mjs`
builds release archives and `scripts/package-npm.mjs` builds npm tarballs locally.
