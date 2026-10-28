# Security policy

Security fixes target the latest version on `main`. Update before reporting a potential issue.

Please report vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/piyush-gambhir/domain-scout/security/advisories/new).
Do not include provider API keys, the `api-token` file, session cookies, or domains you have not made public in a public issue.

How the local engine is protected:

- Domain Scout runs on your machine; nothing is hosted. The backend listens on 127.0.0.1 only, and the
  web UI server is bound to loopback as well (the Docker image publishes it on the host's loopback only).
- Every API request needs the per-install token in `<data dir>/run/api-token` (random 32 bytes, file mode
  0600 in a 0700 directory), or a browser session. Browser sessions start from a single-use sign-in code
  that expires after 60 seconds (15 minutes for the link the Docker image prints). Mutating requests also
  need the CSRF token and an allowed `Origin`, and the API token never reaches browser JavaScript.
- Provider credentials come from environment variables, are kept for the running session only, or are
  saved on request to a separate owner-only credential file. They are never stored in SQLite and never
  appear in API responses, logs, exports, snapshots or retained evidence; provider responses that echo
  credentials are scrubbed before they are stored.
- Scans send names only to registry RDAP and WHOIS services. Names reach purchase providers or marketplaces
  only through the exact-name commands that say so (`quote`, `provider-check`, `aftermarket`) and only the
  providers you list; `diagnose` and `name-check` query DNS, TLS, HTTP, GitHub and package registries for
  the names you pass.
- A newer CLI replaces an older running engine only after confirming the engine's instance id, and the
  engine refuses while jobs, other clients or session-only credentials are active.

Registries, registrars and marketplaces control their own services. Report vulnerabilities in those
services through their own programs.
