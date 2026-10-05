package cli

import (
	"context"
	"net/http"

	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

func (a *App) watchesCmd() *cobra.Command {
	var lp pageFlags
	list := a.newCmd("list", "Watches", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, lp, watchView, func(cursor *string, limit *int) callFn {
				p := api.ListWatchesParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListWatches(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)

	var (
		name          string
		file          string
		providers     []string
		noRegistry    bool
		catalogPrices bool
		interval      int
	)
	create := a.newCmd("create [domains...]", "Create a watch (providers receive the names only when listed)", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if name == "" {
				return usageErr("--name is required")
			}
			ds, err := a.domains(args, file)
			if err != nil {
				return err
			}
			body := api.WatchCreateInput{
				Name:                 name,
				Domains:              ds,
				IncludeRegistry:      ptr(!noRegistry),
				IncludeCatalogPrices: ptr(catalogPrices),
				ProviderIds:          providerIDs(providers),
			}
			if cmd.Flags().Changed("interval") {
				body.IntervalMinutes = ptr(interval)
			}
			return a.show(ctx, watchView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateWatch(ctx, body)
			})
		})
	cf := create.Flags()
	cf.StringVar(&name, "name", "", "watch name (required)")
	cf.StringVarP(&file, "file", "f", "", "file with domains; - reads stdin")
	cf.StringSliceVar(&providers, "providers", nil, "providers to query for confirmations and quotes")
	cf.BoolVar(&noRegistry, "no-registry", false, "skip registry checks")
	cf.BoolVar(&catalogPrices, "catalog-prices", false, "track published suffix prices (no names are sent)")
	cf.IntVar(&interval, "interval", 1440, "check interval in minutes (15 or more)")

	var (
		uName      string
		uFile      string
		uProviders []string
		uRegistry  bool
		uCatalog   bool
		uInterval  int
	)
	update := a.newCmd("update <watch-id> [domains...]", "Edit a watch; only the given fields change", cobra.MinimumNArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "watch id")
			if err != nil {
				return err
			}
			fl := cmd.Flags()
			var body api.WatchPatch
			if fl.Changed("name") {
				body.Name = &uName
			}
			if len(args) > 1 || uFile != "" {
				ds, err := a.domains(args[1:], uFile)
				if err != nil {
					return err
				}
				body.Domains = &ds
			}
			if fl.Changed("providers") {
				ids := providerIDs(uProviders)
				if ids == nil {
					ids = &[]api.ProviderId{}
				}
				body.ProviderIds = ids
			}
			if fl.Changed("registry") {
				body.IncludeRegistry = &uRegistry
			}
			if fl.Changed("catalog-prices") {
				body.IncludeCatalogPrices = &uCatalog
			}
			if fl.Changed("interval") {
				body.IntervalMinutes = &uInterval
			}
			if body == (api.WatchPatch{}) {
				return usageErr("nothing to change: pass --name, domains, --providers, --registry, --catalog-prices or --interval")
			}
			return a.show(ctx, watchView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PatchWatch(ctx, id, body)
			})
		})
	uf := update.Flags()
	uf.StringVar(&uName, "name", "", "new name")
	uf.StringVarP(&uFile, "file", "f", "", "replace domains from a file; - reads stdin")
	uf.StringSliceVar(&uProviders, "providers", nil, "replace providers (empty clears)")
	uf.BoolVar(&uRegistry, "registry", true, "include registry checks")
	uf.BoolVar(&uCatalog, "catalog-prices", false, "track published suffix prices")
	uf.IntVar(&uInterval, "interval", 1440, "check interval in minutes")

	show := a.idCmd("show <watch-id>", "One watch", "watch id", watchView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.GetWatch(ctx, id)
		})
	pause := a.idCmd("pause <watch-id>", "Pause a watch", "watch id", watchView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.PauseWatch(ctx, id)
		})
	resume := a.idCmd("resume <watch-id>", "Resume a watch", "watch id", watchView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.ResumeWatch(ctx, id)
		})
	del := a.idCmd("delete <watch-id>", "Remove a watch (retained evidence is kept)", "watch id", plainView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.DeleteWatch(ctx, id)
		})

	var runWait bool
	var runKey string
	run := a.newCmd("run <watch-id>", "Run a watch now", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "watch id")
			if err != nil {
				return err
			}
			k := keyOrNew(runKey)
			return a.submit(ctx, runWait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.RunWatch(ctx, id, &api.RunWatchParams{IdempotencyKey: &k})
			})
		})
	run.Flags().BoolVar(&runWait, "wait", false, "wait for the run to finish, then print all results")
	idempotencyFlag(run, &runKey)

	var rp pageFlags
	runs := a.newCmd("runs <watch-id>", "Scheduled, missed and completed runs", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "watch id")
			if err != nil {
				return err
			}
			return a.list(ctx, rp, watchRunView, func(cursor *string, limit *int) callFn {
				p := api.ListWatchRunsParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListWatchRuns(ctx, id, &p) }
			})
		})
	addPageFlags(runs, &rp)

	return group("watches", "Monitoring watches", list, create, update, show, pause, resume, del, run, runs)
}

func providerIDs(list []string) *[]api.ProviderId {
	if len(list) == 0 {
		return nil
	}
	ids := make([]api.ProviderId, len(list))
	for i, p := range list {
		ids[i] = providerArg(p)
	}
	return &ids
}

func (a *App) noticesCmd() *cobra.Command {
	var lp pageFlags
	var watchID string
	var unread bool
	list := a.newCmd("list", "Change notices (created only from comparable successful evidence)", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			params := api.ListNoticesParams{WatchId: optStr(watchID)}
			if unread {
				params.Unread = ptr(api.ListNoticesParamsUnreadTrue)
			}
			return a.list(ctx, lp, noticeView, func(cursor *string, limit *int) callFn {
				p := params
				p.Cursor, p.Limit = cursor, limit
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListNotices(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)
	list.Flags().StringVar(&watchID, "watch", "", "only notices for this watch id")
	list.Flags().BoolVar(&unread, "unread", false, "only unread notices")

	var all bool
	read := a.newCmd("read [notice-ids...]", "Mark notices read", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if all == (len(args) > 0) {
				return usageErr("pass notice ids or --all")
			}
			body := api.NoticesMarkRead{}
			if all {
				body.All = ptr(true)
			} else {
				ids, err := parseIDs(args, "notice id")
				if err != nil {
					return err
				}
				body.Ids = &ids
			}
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.MarkNoticesRead(ctx, body)
			})
		})
	read.Flags().BoolVar(&all, "all", false, "mark every notice read")
	return group("notices", "Watch change notices", list, read)
}
