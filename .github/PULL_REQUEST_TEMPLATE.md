## Summary

Describe the problem and resulting behavior.

## Validation

- [ ] `pnpm check` passes (lint, typecheck and tests for every workspace, Go included)
- [ ] `pnpm build` passes; `pnpm test:e2e` passes when the UI changed
- [ ] `pnpm generate` run and committed when contracts changed
- [ ] New behavior is an API route first, then CLI, MCP or UI (docs/IMPLEMENTATION.md, "Clients and the API")
- [ ] Tests use fixtures or local servers; no live lookups beyond the fixed test set
- [ ] No API keys, tokens, real registrant data or personal data included
- [ ] Commits are signed
