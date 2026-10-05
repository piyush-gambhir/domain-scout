package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

func (a *App) historyCmd() *cobra.Command {
	var lp pageFlags
	var q, jobType string
	list := a.newCmd("list", "Past jobs with restorable inputs", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, lp, historyView, func(cursor *string, limit *int) callFn {
				p := api.ListHistoryParams{Q: optStr(q), Type: optStr(jobType), Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListHistory(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)
	list.Flags().StringVar(&q, "q", "", "filter by label or domain")
	list.Flags().StringVar(&jobType, "type", "", "job type")
	return group("history", "Retained job history", list)
}

func (a *App) pricesCmd() *cobra.Command {
	var lp pageFlags
	var domain, suffix, provider, since string
	history := a.newCmd("history", "Comparable observed price series (gaps are never interpolated)", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			params := api.GetPriceHistoryParams{
				Domain:     optStr(strings.ToLower(domain)),
				Suffix:     optStr(strings.Trim(strings.ToLower(suffix), ".")),
				ProviderId: optStr(providerArg(provider)),
			}
			if since != "" {
				t, err := time.Parse(time.RFC3339, since)
				if err != nil {
					return usageErr("--since must be an RFC 3339 timestamp such as 2026-01-01T00:00:00Z")
				}
				params.Since = ptr(t.UTC())
			}
			return a.list(ctx, lp, priceHistoryView, func(cursor *string, limit *int) callFn {
				p := params
				p.Cursor, p.Limit = cursor, limit
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.GetPriceHistory(ctx, &p) }
			})
		})
	addPageFlags(history, &lp)
	history.Flags().StringVar(&domain, "domain", "", "exact domain")
	history.Flags().StringVar(&suffix, "suffix", "", "suffix")
	history.Flags().StringVar(&provider, "provider", "", "provider id")
	history.Flags().StringVar(&since, "since", "", "only observations since this RFC 3339 time")
	return group("prices", "Observed price history", history)
}

func (a *App) portfolioCmd() *cobra.Command {
	var file string
	var replace bool
	imp := a.newCmd("import [file|-]", "Import owned domains with renewal facts (CSV: domain, registrar, renewalDate, renewalPrice, currency, notes)", cobra.MaximumNArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if len(args) == 1 {
				if file != "" {
					return usageErr("give the file as an argument or with --file, not both")
				}
				file = args[0]
			}
			if file == "" {
				return usageErr("pass a CSV file or - for stdin")
			}
			text, err := a.readSource(file)
			if err != nil {
				return err
			}
			body := api.PortfolioImportInput{Text: &text, Replace: ptr(replace)}
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.ImportPortfolio(ctx, body)
			})
		})
	imp.Flags().StringVarP(&file, "file", "f", "", "CSV file; - reads stdin")
	imp.Flags().BoolVar(&replace, "replace", false, "replace the whole portfolio instead of merging")

	var sp pageFlags
	show := a.newCmd("show", "Imported portfolio entries", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, sp, portfolioView, func(cursor *string, limit *int) callFn {
				p := api.ListPortfolioParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListPortfolio(ctx, &p) }
			})
		})
	addPageFlags(show, &sp)

	var cp pageFlags
	compare := a.newCmd("compare", "Compare renewal and transfer costs from retained data", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, cp, portfolioCompareView, func(cursor *string, limit *int) callFn {
				p := api.ComparePortfolioParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ComparePortfolio(ctx, &p) }
			})
		})
	addPageFlags(compare, &cp)

	remove := a.idCmd("remove <entry-id>", "Remove a portfolio entry", "entry id", plainView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.DeletePortfolioEntry(ctx, id)
		})
	return group("portfolio", "Owned domains and renewal comparisons", imp, show, compare, remove)
}

func (a *App) dataCmd() *cobra.Command {
	inspect := a.newCmd("inspect", "Local data location and record counts", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.show(ctx, dataInventoryView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.GetDataInventory(ctx)
			})
		})

	var (
		categories []string
		shortlists []string
		before     string
		yes        bool
	)
	del := a.newCmd("delete", "Scoped deletion of local data (requires --yes; never prompts)", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if len(categories) == 0 {
				return usageErr("--categories is required, e.g. jobs,registry_evidence,price_history")
			}
			body := api.DataDelete{Categories: make([]api.DataCategory, len(categories))}
			for i, c := range categories {
				body.Categories[i] = api.DataCategory(c)
				if !body.Categories[i].Valid() {
					return usageErr("unknown category %q", c)
				}
			}
			if len(shortlists) > 0 {
				ids, err := parseIDs(shortlists, "--shortlists")
				if err != nil {
					return err
				}
				body.CollectionIds = &ids
			}
			if before != "" {
				t, err := time.Parse(time.RFC3339, before)
				if err != nil {
					return usageErr("--before must be an RFC 3339 timestamp")
				}
				body.Before = ptr(t.UTC())
			}
			if !yes {
				return usageErr("data delete removes local records; re-run with --yes to confirm (the CLI never prompts)")
			}
			return a.show(ctx, dataDeleteView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.DeleteData(ctx, body)
			})
		})
	fl := del.Flags()
	fl.StringSliceVar(&categories, "categories", nil, "jobs, registry_evidence, provider_evidence, price_history, name_checks, diagnostics, raw_diagnostics, collections, criteria, watches, portfolio, artifacts")
	fl.StringSliceVar(&shortlists, "shortlists", nil, "limit collection deletion to these shortlist ids")
	fl.StringVar(&before, "before", "", "only records older than this RFC 3339 time")
	fl.BoolVar(&yes, "yes", false, "confirm the deletion")
	return group("data", "Local data inventory and scoped deletion", inspect, del)
}

func (a *App) evidenceCmd() *cobra.Command {
	domainCmd := func(use, short string, v view, fn func(ctx context.Context, g *api.Client, domain string) (*http.Response, error)) *cobra.Command {
		return a.newCmd(use, short, cobra.ExactArgs(1), func(ctx context.Context, cmd *cobra.Command, args []string) error {
			domain := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(args[0])), ".")
			return a.show(ctx, v, func(ctx context.Context, g *api.Client) (*http.Response, error) { return fn(ctx, g, domain) })
		})
	}
	domainList := func(use, short string, v view, fn func(ctx context.Context, g *api.Client, domain string, cursor *string, limit *int) (*http.Response, error)) *cobra.Command {
		var lp pageFlags
		cmd := a.newCmd(use, short, cobra.ExactArgs(1), func(ctx context.Context, cmd *cobra.Command, args []string) error {
			domain := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(args[0])), ".")
			return a.list(ctx, lp, v, func(cursor *string, limit *int) callFn {
				return func(ctx context.Context, g *api.Client) (*http.Response, error) {
					return fn(ctx, g, domain, cursor, limit)
				}
			})
		})
		addPageFlags(cmd, &lp)
		return cmd
	}
	show := domainCmd("show <domain>", "All retained evidence for a domain: registry, confirmations, offers, checks and purchase links", plainView,
		func(ctx context.Context, g *api.Client, d string) (*http.Response, error) {
			return g.GetDomainEvidence(ctx, d)
		})
	offers := domainList("offers <domain>", "Catalog and quote offers matching a domain", offerView,
		func(ctx context.Context, g *api.Client, d string, cursor *string, limit *int) (*http.Response, error) {
			return g.ListDomainOffers(ctx, d, &api.ListDomainOffersParams{Cursor: cursor, Limit: limit})
		})
	listings := domainList("listings <domain>", "Retained aftermarket listing evidence", listingView,
		func(ctx context.Context, g *api.Client, d string, cursor *string, limit *int) (*http.Response, error) {
			return g.ListDomainListings(ctx, d, &api.ListDomainListingsParams{Cursor: cursor, Limit: limit})
		})
	transfers := domainList("transfer-options <domain>", "Read-only transfer comparison from retained data", transferOptionView,
		func(ctx context.Context, g *api.Client, d string, cursor *string, limit *int) (*http.Response, error) {
			return g.ListDomainTransferOptions(ctx, d, &api.ListDomainTransferOptionsParams{Cursor: cursor, Limit: limit})
		})
	raw := a.idCmd("raw <observation-id>", "Sanitized raw source response, when retained", "observation id", plainView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.GetRawDiagnostic(ctx, id)
		})
	return group("evidence", "Retained evidence per domain", show, offers, listings, transfers, raw)
}

func (a *App) settingsCmd() *cobra.Command {
	show := a.newCmd("show", "Current settings", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.GetSettings(ctx)
			})
		})
	set := a.newCmd("set <key=value>...", "Update settings by dotted key, e.g. concurrency.global=8 privacy.keepRawDiagnostics=true", cobra.MinimumNArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			patch, err := settingsPatch(args)
			if err != nil {
				return err
			}
			body, _ := json.Marshal(patch)
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PatchSettingsWithBody(ctx, "application/json", bytes.NewReader(body))
			})
		})
	return group("settings", "Backend settings", show, set)
}

// settingsPatch turns dotted key=value pairs into a nested SettingsPatch
// object. Values parse as JSON when possible (numbers, booleans, null,
// arrays), otherwise as strings.
func settingsPatch(pairs []string) (map[string]any, error) {
	root := map[string]any{}
	for _, pair := range pairs {
		k, v, ok := strings.Cut(pair, "=")
		if !ok || k == "" {
			return nil, usageErr("settings set expects key=value, got %q", pair)
		}
		var value any
		if err := json.Unmarshal([]byte(v), &value); err != nil {
			value = v
		}
		parts := strings.Split(k, ".")
		node := root
		for i, p := range parts {
			if i == len(parts)-1 {
				node[p] = value
				break
			}
			next, ok := node[p].(map[string]any)
			if !ok {
				next = map[string]any{}
				node[p] = next
			}
			node = next
		}
	}
	return root, nil
}

func (a *App) capabilitiesCmd() *cobra.Command {
	return a.newCmd("capabilities", "Supported features, coverage counts and provider readiness", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.GetCapabilities(ctx)
			})
		})
}
