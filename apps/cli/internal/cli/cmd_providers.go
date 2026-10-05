package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

func (a *App) coverageCmd() *cobra.Command {
	var lp pageFlags
	var status, q string
	list := a.newCmd("list", "Per-suffix routing provenance and tested/discovered/unsupported status", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			params := api.ListCoverageParams{Q: optStr(q)}
			if status != "" {
				if !api.ListCoverageParamsStatus(status).Valid() {
					return usageErr("--status must be tested, discovered or unsupported")
				}
				params.Status = ptr(api.ListCoverageParamsStatus(status))
			}
			return a.list(ctx, lp, coverageView, func(cursor *string, limit *int) callFn {
				p := params
				p.Cursor, p.Limit = cursor, limit
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListCoverage(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)
	list.Flags().StringVar(&status, "status", "", "tested, discovered or unsupported")
	list.Flags().StringVar(&q, "q", "", "filter suffixes")

	show := a.newCmd("show <suffix>", "Coverage for one suffix", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			suffix := strings.Trim(strings.ToLower(args[0]), ".")
			return a.show(ctx, coverageView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.GetSuffixCoverage(ctx, suffix)
			})
		})
	summary := a.newCmd("summary", "Coverage counts, bootstrap dates and limits", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.show(ctx, coverageSummaryView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.GetCoverageSummary(ctx)
			})
		})
	refresh := a.newCmd("refresh", "Refresh IANA bootstrap metadata (no candidate names are sent)", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.show(ctx, coverageSummaryView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.RefreshCoverage(ctx)
			})
		})
	return group("coverage", "Proven versus discovered registry support", list, show, summary, refresh)
}

func providerArg(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func (a *App) providersCmd() *cobra.Command {
	var lp pageFlags
	list := a.newCmd("list", "Providers, capabilities and readiness", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, lp, providerView, func(cursor *string, limit *int) callFn {
				p := api.ListProvidersParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListProviders(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)

	show := a.newCmd("show <provider>", "One provider with capabilities and credential state (never secrets)", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id := providerArg(args[0])
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.GetProvider(ctx, id)
			})
		})

	patch := func(use, short string, body func(cmd *cobra.Command) api.ProviderPreferencesPatch) *cobra.Command {
		return a.newCmd(use, short, cobra.ExactArgs(1), func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id := providerArg(args[0])
			b := body(cmd)
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PatchProvider(ctx, id, b)
			})
		})
	}
	enable := patch("enable <provider>", "Enable a provider", func(*cobra.Command) api.ProviderPreferencesPatch {
		return api.ProviderPreferencesPatch{Enabled: ptr(true)}
	})
	disable := patch("disable <provider>", "Disable a provider", func(*cobra.Command) api.ProviderPreferencesPatch {
		return api.ProviderPreferencesPatch{Enabled: ptr(false)}
	})
	var unset bool
	prefer := patch("prefer <provider>", "Mark a provider preferred (--unset clears it)", func(*cobra.Command) api.ProviderPreferencesPatch {
		return api.ProviderPreferencesPatch{Preferred: ptr(!unset)}
	})
	prefer.Flags().BoolVar(&unset, "unset", false, "clear the preferred mark")

	test := a.newCmd("test <provider>", "Test credentials with a non-candidate account operation (exit 4 when they fail)", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id := providerArg(args[0])
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.TestProviderCredentials(ctx, id)
			})
			if err != nil {
				return err
			}
			if err := a.emit(res.body, credentialTestView); err != nil {
				return err
			}
			return credentialTestExit(res.body)
		})

	disconnect := a.newCmd("disconnect <provider>", "Remove saved credentials", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id := providerArg(args[0])
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.DeleteProviderCredentials(ctx, id)
			})
		})

	return group("providers", "Purchase providers, capabilities and optional credentials",
		list, show, enable, disable, prefer, a.configureCmd(), test, disconnect)
}

func credentialTestExit(body []byte) error {
	var tr api.CredentialTestResponse
	if err := json.Unmarshal(body, &tr); err != nil {
		return failErr("backend returned a malformed credential test: %v", err)
	}
	if tr.Data.Result == api.CredentialTestResultFailed {
		return &exitError{code: ExitAccess, note: true, msg: "credential test failed: " + tr.Data.Message}
	}
	return nil
}

func (a *App) configureCmd() *cobra.Command {
	var (
		values  []string
		fromEnv bool
		stdin   bool
		storage string
		test    bool
	)
	cmd := a.newCmd("configure <provider>", "Save provider credentials from flags, environment or stdin (values are never printed)", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id := providerArg(args[0])
			st := api.CredentialsPutStorage(storage)
			if !st.Valid() {
				return usageErr("--storage must be session or file")
			}
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.GetProvider(ctx, id) })
			if err != nil {
				return err
			}
			var pr api.ProviderResponse
			if err := json.Unmarshal(res.body, &pr); err != nil {
				return failErr("backend returned a malformed provider: %v", err)
			}
			collected, err := a.credentialValues(pr.Data.CredentialFields, values, fromEnv, stdin)
			if err != nil {
				return err
			}
			res, err = c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PutProviderCredentials(ctx, id, api.CredentialsPut{Values: collected, Storage: st})
			})
			if err != nil {
				return err
			}
			a.progress("Saved %d credential field(s) for %s (storage: %s).", len(collected), id, storage)
			if !test {
				return a.emit(res.body, plainView)
			}
			tres, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.TestProviderCredentials(ctx, id)
			})
			if err != nil {
				return err
			}
			// Print the provider with its updated test state, then map the result.
			res, err = c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.GetProvider(ctx, id) })
			if err != nil {
				return err
			}
			if err := a.emit(res.body, plainView); err != nil {
				return err
			}
			return credentialTestExit(tres.body)
		})
	fl := cmd.Flags()
	fl.StringArrayVar(&values, "value", nil, "field value as key=value (repeatable; prefer --from-env or --stdin for secrets)")
	fl.BoolVar(&fromEnv, "from-env", false, "read each field from its documented environment variable")
	fl.BoolVar(&stdin, "stdin", false, "read key=value lines or a JSON object from stdin")
	fl.StringVar(&storage, "storage", "session", "session (memory until the backend stops) or file (owner-only credential file)")
	fl.BoolVar(&test, "test", false, "test the credentials after saving (exit 4 when the test fails)")
	return cmd
}

// credentialValues merges environment, stdin and flag values (flags win) and
// checks them against the provider's declared fields. Error messages name
// keys only, never values.
func (a *App) credentialValues(fields []api.CredentialField, flagValues []string, fromEnv, stdin bool) (map[string]string, error) {
	known := map[string]api.CredentialField{}
	for _, f := range fields {
		known[f.Key] = f
	}
	if len(fields) == 0 {
		return nil, usageErr("this provider has no configurable credentials")
	}
	values := map[string]string{}
	if fromEnv {
		for _, f := range fields {
			if v := a.Getenv(f.EnvVar); f.EnvVar != "" && v != "" {
				values[f.Key] = v
			}
		}
	}
	if stdin {
		text, err := a.readSource("-")
		if err != nil {
			return nil, err
		}
		parsed, err := parseCredentialText(text)
		if err != nil {
			return nil, err
		}
		for k, v := range parsed {
			values[k] = v
		}
	}
	for _, kv := range flagValues {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || strings.TrimSpace(k) == "" {
			return nil, usageErr("--value expects key=value")
		}
		values[strings.TrimSpace(k)] = v
	}
	var unknown []string
	for k := range values {
		if _, ok := known[k]; !ok {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return nil, usageErr("unknown credential field(s) %s; this provider accepts %s", strings.Join(unknown, ", "), fieldList(fields))
	}
	var missing []string
	for _, f := range fields {
		if f.Required && values[f.Key] == "" {
			hint := f.Key
			if f.EnvVar != "" {
				hint += " (env " + f.EnvVar + ")"
			}
			missing = append(missing, hint)
		}
	}
	if len(missing) > 0 {
		return nil, usageErr("missing required credential field(s): %s", strings.Join(missing, ", "))
	}
	if len(values) == 0 {
		return nil, usageErr("no credential values given: use --from-env, --stdin or --value key=value")
	}
	return values, nil
}

func fieldList(fields []api.CredentialField) string {
	out := make([]string, len(fields))
	for i, f := range fields {
		out[i] = f.Key
	}
	return strings.Join(out, ", ")
}

func parseCredentialText(text string) (map[string]string, error) {
	trimmed := strings.TrimSpace(text)
	out := map[string]string{}
	if strings.HasPrefix(trimmed, "{") {
		if err := json.Unmarshal([]byte(trimmed), &out); err != nil {
			return nil, usageErr("stdin is not a JSON object of string values")
		}
		return out, nil
	}
	for i, line := range strings.Split(trimmed, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, usageErr("stdin line %d is not key=value", i+1)
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out, nil
}

func (a *App) catalogCmd() *cobra.Command {
	var wait bool
	var key string
	refresh := a.newCmd("refresh <provider>", "Fetch a provider's published catalog (no candidate names are sent)", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id := providerArg(args[0])
			k := keyOrNew(key)
			return a.submit(ctx, wait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.RefreshProviderCatalog(ctx, id, &api.RefreshProviderCatalogParams{IdempotencyKey: &k})
			})
		})
	refresh.Flags().BoolVar(&wait, "wait", false, "wait for the refresh job to finish, then print its results")
	idempotencyFlag(refresh, &key)

	var lp pageFlags
	var suffix string
	list := a.newCmd("list <provider>", "Latest published suffix prices from a provider catalog", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id := providerArg(args[0])
			return a.list(ctx, lp, offerView, func(cursor *string, limit *int) callFn {
				p := api.ListProviderCatalogParams{Suffix: optStr(strings.Trim(strings.ToLower(suffix), ".")), Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) {
					return g.ListProviderCatalog(ctx, id, &p)
				}
			})
		})
	addPageFlags(list, &lp)
	list.Flags().StringVar(&suffix, "suffix", "", "only this suffix")
	return group("catalog", "Provider price catalogs", refresh, list)
}

// providerJob builds provider-check, quote and transfer compare: explicit
// domains sent to explicitly selected providers.
func (a *App) providerJob(use, short string, create func(ctx context.Context, g *api.Client, key string, body api.ProviderJobBody) (*http.Response, error)) *cobra.Command {
	var (
		file      string
		providers []string
		label     string
		wait      bool
		key       string
	)
	cmd := a.newCmd(use, short, cobra.ArbitraryArgs, func(ctx context.Context, cmd *cobra.Command, args []string) error {
		if len(providers) == 0 {
			return usageErr("--providers is required: names are only sent to providers you select")
		}
		ds, err := a.domains(args, file)
		if err != nil {
			return err
		}
		ids := make([]api.ProviderId, len(providers))
		for i, p := range providers {
			ids[i] = providerArg(p)
		}
		body := api.ProviderJobBody{Domains: ds, ProviderIds: ids, Label: optStr(label)}
		k := keyOrNew(key)
		return a.submit(ctx, wait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
			return create(ctx, g, k, body)
		})
	})
	cmd.Flags().StringVarP(&file, "file", "f", "", "file with domains; - reads stdin")
	cmd.Flags().StringSliceVar(&providers, "providers", nil, "provider ids to query (required)")
	cmd.Flags().StringVar(&label, "label", "", "job label")
	cmd.Flags().BoolVar(&wait, "wait", false, "wait for the job to finish, then print all results (exit 4 if any item needs credentials)")
	idempotencyFlag(cmd, &key)
	return cmd
}

func (a *App) providerCheckCmd() *cobra.Command {
	return a.providerJob("provider-check [domains...]", "Exact-name availability confirmation from selected providers",
		func(ctx context.Context, g *api.Client, key string, body api.ProviderJobBody) (*http.Response, error) {
			return g.CreateProviderChecks(ctx, &api.CreateProviderChecksParams{IdempotencyKey: &key}, body)
		})
}

func (a *App) quoteCmd() *cobra.Command {
	return a.providerJob("quote [domains...]", "Exact-name quotes from selected providers",
		func(ctx context.Context, g *api.Client, key string, body api.ProviderJobBody) (*http.Response, error) {
			return g.CreateQuotes(ctx, &api.CreateQuotesParams{IdempotencyKey: &key}, body)
		})
}

func (a *App) transferCmd() *cobra.Command {
	compare := a.providerJob("compare [domains...]", "Read-only transfer price quotes from selected providers",
		func(ctx context.Context, g *api.Client, key string, body api.ProviderJobBody) (*http.Response, error) {
			return g.CreateTransfers(ctx, &api.CreateTransfersParams{IdempotencyKey: &key}, body)
		})
	return group("transfer", "Read-only transfer comparisons (no authorization codes are handled)", compare)
}

func (a *App) compareCmd() *cobra.Command {
	var (
		file      string
		horizon   int
		path      string
		currency  string
		providers []string
		region    string
	)
	cmd := a.newCmd("compare [domains...]", "Ownership cost comparison from retained offers", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			ds, err := a.domains(args, file)
			if err != nil {
				return err
			}
			if horizon < 1 || horizon > 10 {
				return usageErr("--horizon must be between 1 and 10 years")
			}
			pp := api.PurchasePath(path)
			if !pp.Valid() {
				return usageErr("--path must be new_registration, renewal, transfer or aftermarket")
			}
			body := api.ComparisonRequestInput{Domains: ds, HorizonYears: ptr(horizon), PurchasePath: &pp, Region: optStr(region)}
			if currency != "" {
				if !currencyRe.MatchString(currency) {
					return usageErr("--currency must be an ISO 4217 code such as USD")
				}
				body.Currency = &currency
			}
			if len(providers) > 0 {
				ids := make([]api.ProviderId, len(providers))
				for i, p := range providers {
					ids[i] = providerArg(p)
				}
				body.ProviderIds = &ids
			}
			return a.show(ctx, comparisonView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateComparison(ctx, body)
			})
		})
	fl := cmd.Flags()
	fl.StringVarP(&file, "file", "f", "", "file with domains; - reads stdin")
	fl.IntVar(&horizon, "horizon", 3, "comparison horizon in years (1-10)")
	fl.StringVar(&path, "path", "new_registration", "purchase path: new_registration, renewal, transfer or aftermarket")
	fl.StringVar(&currency, "currency", "", "comparison currency (requires an attributed FX rate in settings)")
	fl.StringSliceVar(&providers, "providers", nil, "limit to these provider ids")
	fl.StringVar(&region, "region", "", "pricing region")
	return cmd
}

func (a *App) aftermarketCmd() *cobra.Command {
	var (
		file        string
		sources     []string
		label       string
		wait        bool
		key         string
		listSources bool
	)
	cmd := a.newCmd("aftermarket [domains...]", "Aftermarket listing lookups on selected marketplaces", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if listSources {
				if len(args) > 0 || len(sources) > 0 {
					return usageErr("--list-sources takes no domains or --sources")
				}
				return a.show(ctx, aftermarketSourceView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
					return g.ListAftermarketSources(ctx)
				})
			}
			if len(sources) == 0 {
				return usageErr("--sources is required (see --list-sources)")
			}
			ds, err := a.domains(args, file)
			if err != nil {
				return err
			}
			body := api.AftermarketJobBody{Domains: ds, Sources: sources, Label: optStr(label)}
			k := keyOrNew(key)
			return a.submit(ctx, wait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateAftermarket(ctx, &api.CreateAftermarketParams{IdempotencyKey: &k}, body)
			})
		})
	fl := cmd.Flags()
	fl.StringVarP(&file, "file", "f", "", "file with domains; - reads stdin")
	fl.StringSliceVar(&sources, "sources", nil, "marketplace ids to query (required)")
	fl.StringVar(&label, "label", "", "job label")
	fl.BoolVar(&wait, "wait", false, "wait for the job to finish, then print all results")
	fl.BoolVar(&listSources, "list-sources", false, "list supported marketplaces instead of submitting")
	idempotencyFlag(cmd, &key)
	return cmd
}

func (a *App) nameCheckCmd() *cobra.Command {
	var (
		file         string
		services     []string
		label        string
		wait         bool
		key          string
		listServices bool
	)
	cmd := a.newCmd("name-check [names...]", "Selected social, GitHub and package-name checks", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if listServices {
				if len(args) > 0 || len(services) > 0 {
					return usageErr("--list-services takes no names or --services")
				}
				return a.show(ctx, nameCheckServiceView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
					return g.ListNameCheckServices(ctx)
				})
			}
			if len(services) == 0 {
				return usageErr("--services is required (see --list-services)")
			}
			names, err := a.names(args, file)
			if err != nil {
				return err
			}
			if len(names) == 0 {
				return usageErr("no names given: pass them as arguments or with --file")
			}
			svc := make([]api.NameCheckServiceId, len(services))
			for i, s := range services {
				svc[i] = api.NameCheckServiceId(s)
				if !svc[i].Valid() {
					return usageErr("unknown --services value %q (see --list-services)", s)
				}
			}
			body := api.NameCheckJobBody{Names: names, Services: svc, Label: optStr(label)}
			k := keyOrNew(key)
			return a.submit(ctx, wait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateNameChecks(ctx, &api.CreateNameChecksParams{IdempotencyKey: &k}, body)
			})
		})
	fl := cmd.Flags()
	fl.StringVarP(&file, "file", "f", "", "file with names; - reads stdin")
	fl.StringSliceVar(&services, "services", nil, "services to check, e.g. github,npm,pypi (required)")
	fl.StringVar(&label, "label", "", "job label")
	fl.BoolVar(&wait, "wait", false, "wait for the job to finish, then print all results")
	fl.BoolVar(&listServices, "list-services", false, "list supported and unsupported services instead of submitting")
	idempotencyFlag(cmd, &key)
	return cmd
}

func (a *App) diagnoseCmd() *cobra.Command {
	var (
		file     string
		checks   []string
		resolver string
		label    string
		wait     bool
		key      string
	)
	cmd := a.newCmd("diagnose [domains...]", "Selected DNS, DNSSEC, TLS and HTTP diagnostics (never change registry outcomes)", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if len(checks) == 0 {
				return usageErr("--checks is required: dns, nameservers, dnssec, tls, http")
			}
			cs := make([]api.DiagnosticCheck, len(checks))
			for i, s := range checks {
				cs[i] = api.DiagnosticCheck(s)
				if !cs[i].Valid() {
					return usageErr("unknown --checks value %q: use dns, nameservers, dnssec, tls or http", s)
				}
			}
			rv := api.Resolver(resolver)
			if !rv.Valid() {
				return usageErr("--resolver must be system, cloudflare or google")
			}
			ds, err := a.domains(args, file)
			if err != nil {
				return err
			}
			body := api.DiagnosticsJobBodyInput{Domains: ds, Checks: cs, Resolver: &rv, Label: optStr(label)}
			k := keyOrNew(key)
			return a.submit(ctx, wait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateDiagnostics(ctx, &api.CreateDiagnosticsParams{IdempotencyKey: &k}, body)
			})
		})
	fl := cmd.Flags()
	fl.StringVarP(&file, "file", "f", "", "file with domains; - reads stdin")
	fl.StringSliceVar(&checks, "checks", nil, "checks to run: dns, nameservers, dnssec, tls, http (required)")
	fl.StringVar(&resolver, "resolver", "system", "system, cloudflare or google")
	fl.StringVar(&label, "label", "", "job label")
	fl.BoolVar(&wait, "wait", false, "wait for the job to finish, then print all results")
	idempotencyFlag(cmd, &key)
	return cmd
}
