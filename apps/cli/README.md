# Domain Scout CLI

The Go CLI calls the local Domain Scout HTTP API. It uses the shared runtime
files and starts installed backend assets when needed. Run
`domain-scout service start` to start the backend explicitly.

## MCP server

Register the stdio server in your MCP client's configuration:

```json
{
  "mcpServers": {
    "domain-scout": {
      "command": "domain-scout",
      "args": ["mcp"]
    }
  }
}
```

Put `domain-scout` on PATH. Global flags such as `--data-dir` and `--backend-url`
can be added to the args array. stdout contains MCP messages only; diagnostics
and startup progress go to stderr.

Tools: `preview_input`, `scan`, `job_status`, `job_results`, `domain_evidence`,
`suffix_prices`, `generate_candidates`, `shortlist_list`, `shortlist_add`,
`quote`, `coverage`.

Preview and generation make no external queries. Scan sends names only to
registry services. Quotes send exact names to the explicitly listed providers,
with missing access reported as `credential_required`. `no_record` means no
registry record, never guaranteed registration eligibility.

Scan and quote wait by default, bounded by `timeout` in seconds (default 120,
range 1 to 3600). Use `wait: false` to submit without waiting. Completed waits
return the `job` envelope and the first 100 `results` rows; page the rest with
`job_results` and its `cursor`. A timed-out wait returns the submitted
`job` envelope with `timed_out: true`; the backend job is not cancelled.
`job_results` returns up to 100 rows by default and preserves pagination metadata.
