# Security policy

Security fixes target the latest version on `main`. Update before reporting a potential issue.

Please report vulnerabilities privately using [GitHub private vulnerability reporting](https://github.com/piyush-gambhir/domain-scout/security/advisories/new).
Do not include provider API keys, the `api-token` file, session cookies, or domains you have not made public in a public issue.

How the local engine is protected:

- Domain Scout runs on your machine; nothing is hosted. The backend listens on 127.0.0.1 only, and the
  web UI server is bound to loopback as well (the Docker image publishes it on the host's loopback only).
- Apart from the health check and the exchange of a sign-in code, every API request needs the per-install
  token in `<data dir>/run/api-token` (random 32 bytes, file mode 0600 in a 0700 directory) or a browser
  session. Browser sessions start from a single-use sign-in code that expires after 60 seconds (15 minutes
  for the link the Docker image prints). Session requests that change data also need the CSRF token, any
  request whose `Origin` is not an allowed web origin is refused, and the API token never reaches browser
  JavaScript.
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

## Reviewed scanner findings

Reviewed on 2026-10-29. These exceptions describe the current code and maintainer model.
Reassess them when authentication, transports, maintainers, or deployment boundaries change.

- **Code-Review and Branch-Protection:** this is a solo-maintained project. Pull requests and
  required automated checks provide the merge gate; there is no independent human approver.
  An automated or AI review is useful but is not independent human review. Zero required
  human approvals is an accepted limitation, not a claim that this Scorecard check is satisfied.
- **Maintained:** the initial assessment covered a newly created repository with a short
  activity history. Reassess commit and issue activity over time; age alone does not
  establish maintenance.
- **CII-Best-Practices:** an OpenSSF Best Practices badge is optional assurance work.
  Its absence is not a demonstrated application vulnerability.

CodeQL findings reviewed against their call sites:

| Rule | Assessment | Conditions that must remain true |
| --- | --- | --- |
| `js/disabling-certificate-validation` | Intentional diagnostic exception in `nodeTlsProbe` | Only the TLS handshake and certificate are inspected, no credentials or application payload are sent, `authorized` and `authorizationError` are retained, and the socket is closed. The separate HTTPS transport must keep certificate validation enabled. An untrusted observation is not authenticated evidence. |
| `js/insufficient-password-hash` | False positive for `safeEqual` in `runtime/token.ts` | API tokens, session IDs and bootstrap codes are generated from 32 cryptographically random bytes. SHA-256 equalizes comparison lengths and stores random-token verifiers; this is not human password storage. Human passwords would need an appropriate password KDF. |
| `js/incomplete-url-substring-sanitization` | Historical false positive in `scripts/smoke.mjs` | The original string check was a CSV assertion, not a URL or redirect gate. The current smoke test compares parsed domain rows, preserving the same security boundary. |

The earlier Go dependency, Docker base-image and SSE retry issues are now fixed on main.
They are actionable findings, not covered by the exceptions above. The security workflow
also scans the selected OpenAPI generator and fuzzes both parser targets.

References: [CodeQL rules](https://codeql.github.com/codeql-query-help/javascript/),
[OWASP random-token storage](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#server-side-session-token-storage),
[Scorecard checks](https://github.com/ossf/scorecard/blob/main/docs/checks.md).
