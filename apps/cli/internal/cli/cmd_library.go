package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

func (a *App) shortlistCmd() *cobra.Command {
	var lp pageFlags
	list := a.newCmd("list", "List shortlists", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, lp, collectionView, func(cursor *string, limit *int) callFn {
				p := api.ListCollectionsParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListCollections(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)

	var createNotes string
	create := a.newCmd("create <name>", "Create a shortlist", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			body := api.CollectionCreate{Name: args[0], Notes: optStr(createNotes)}
			return a.show(ctx, collectionView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateCollection(ctx, body)
			})
		})
	create.Flags().StringVar(&createNotes, "notes", "", "shortlist notes")

	show := a.idCmd("show <shortlist-id>", "One shortlist", "shortlist id", collectionView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.GetCollection(ctx, id)
		})

	var ep pageFlags
	entries := a.newCmd("entries <shortlist-id>", "Shortlist entries with latest evidence and offers", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "shortlist id")
			if err != nil {
				return err
			}
			return a.list(ctx, ep, collectionEntryView, func(cursor *string, limit *int) callFn {
				p := api.ListCollectionEntriesParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) {
					return g.ListCollectionEntries(ctx, id, &p)
				}
			})
		})
	addPageFlags(entries, &ep)

	var addFile, addNotes string
	add := a.newCmd("add <shortlist-id> [domains...]", "Add domains to a shortlist", cobra.MinimumNArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "shortlist id")
			if err != nil {
				return err
			}
			ds, err := a.domains(args[1:], addFile)
			if err != nil {
				return err
			}
			body := api.CollectionEntriesAdd{Domains: ds, Notes: optStr(addNotes)}
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.AddCollectionEntries(ctx, id, body)
			})
		})
	add.Flags().StringVarP(&addFile, "file", "f", "", "file with domains; - reads stdin")
	add.Flags().StringVar(&addNotes, "notes", "", "notes for the added entries")

	var removeFile string
	remove := a.newCmd("remove <shortlist-id> [domains...]", "Remove domains from a shortlist", cobra.MinimumNArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "shortlist id")
			if err != nil {
				return err
			}
			ds, err := a.domains(args[1:], removeFile)
			if err != nil {
				return err
			}
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.RemoveCollectionEntries(ctx, id, api.CollectionEntriesRemove{Domains: ds})
			})
		})
	remove.Flags().StringVarP(&removeFile, "file", "f", "", "file with domains; - reads stdin")

	rename := a.newCmd("rename <shortlist-id> <name>", "Rename a shortlist", cobra.ExactArgs(2),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "shortlist id")
			if err != nil {
				return err
			}
			return a.show(ctx, collectionView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PatchCollection(ctx, id, api.CollectionPatch{Name: &args[1]})
			})
		})

	del := a.idCmd("delete <shortlist-id>", "Delete a shortlist (evidence is kept)", "shortlist id", plainView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.DeleteCollection(ctx, id)
		})

	return group("shortlist", "Persistent shortlists (collections)", list, create, show, entries, add, remove, rename, del)
}

func (a *App) notesCmd() *cobra.Command {
	var text, textFile string
	var clear bool
	set := a.newCmd("set <shortlist-id> [domain]", "Set shortlist notes, or notes for one entry when a domain is given", cobra.RangeArgs(1, 2),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "shortlist id")
			if err != nil {
				return err
			}
			given := 0
			for _, b := range []bool{text != "", textFile != "", clear} {
				if b {
					given++
				}
			}
			if given != 1 {
				return usageErr("give exactly one of --text, --text-file or --clear")
			}
			var notes *string
			switch {
			case textFile != "":
				t, err := a.readSource(textFile)
				if err != nil {
					return err
				}
				notes = &t
			case text != "":
				notes = &text
			}
			if len(args) == 2 {
				domain := strings.TrimSuffix(strings.ToLower(args[1]), ".")
				return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
					return g.PatchCollectionEntry(ctx, id, domain, api.CollectionEntryPatch{Notes: notes})
				})
			}
			// CollectionPatch.notes is nullable and optional; the generated
			// type omits nil, so send the body directly to allow clearing.
			body, _ := json.Marshal(map[string]any{"notes": notes})
			return a.show(ctx, collectionView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PatchCollectionWithBody(ctx, id, "application/json", bytes.NewReader(body))
			})
		})
	set.Flags().StringVar(&text, "text", "", "notes text")
	set.Flags().StringVar(&textFile, "text-file", "", "read notes from a file; - reads stdin")
	set.Flags().BoolVar(&clear, "clear", false, "remove the notes")
	return group("notes", "Shortlist and entry notes", set)
}

func (a *App) criteriaCmd() *cobra.Command {
	var lp pageFlags
	list := a.newCmd("list", "Saved search criteria", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, lp, criteriaView, func(cursor *string, limit *int) callFn {
				p := api.ListCriteriaParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListCriteria(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)

	var (
		name           string
		replace        string
		tlds           []string
		providers      []string
		budget         string
		budgetCurrency string
		inputFile      string
		generationFile string
		ff             filterFlags
	)
	save := a.newCmd("save", "Save criteria (filter, extensions, providers, budget, generation, input); restoring runs no queries", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if name == "" {
				return usageErr("--name is required")
			}
			body := api.SavedCriteriaCreateInput{Name: name, Extensions: optSlice(suffixes(tlds))}
			if ff.set() {
				if err := ff.validate(); err != nil {
					return err
				}
				f := ff.filter()
				body.Filter = &f
			}
			if len(providers) > 0 {
				ids := make([]api.ProviderId, len(providers))
				for i, p := range providers {
					ids[i] = providerArg(p)
				}
				body.ProviderIds = &ids
			}
			if budget != "" || budgetCurrency != "" {
				if !decimalRe.MatchString(budget) || !currencyRe.MatchString(budgetCurrency) {
					return usageErr("--budget needs a decimal amount and --budget-currency an ISO 4217 code")
				}
				body.Budget = &struct {
					Amount   api.DecimalString `json:"amount"`
					Currency api.CurrencyCode  `json:"currency"`
				}{Amount: budget, Currency: budgetCurrency}
			}
			if inputFile != "" {
				t, err := a.readSource(inputFile)
				if err != nil {
					return err
				}
				body.Input = &t
			}
			if generationFile != "" {
				t, err := a.readSource(generationFile)
				if err != nil {
					return err
				}
				var gen api.GenerationRequestInput
				dec := json.NewDecoder(strings.NewReader(t))
				dec.DisallowUnknownFields()
				if err := dec.Decode(&gen); err != nil {
					return usageErr("--generation must be a GenerationRequest JSON object: %v", err)
				}
				body.Generation = &gen
			}
			if replace != "" {
				id, err := parseID(replace, "--replace")
				if err != nil {
					return err
				}
				return a.show(ctx, criteriaView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
					return g.PutCriteria(ctx, id, body)
				})
			}
			return a.show(ctx, criteriaView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateCriteria(ctx, body)
			})
		})
	fl := save.Flags()
	fl.StringVar(&name, "name", "", "criteria name (required)")
	fl.StringVar(&replace, "replace", "", "replace the saved criteria with this id")
	fl.StringSliceVar(&tlds, "tlds", nil, "extensions")
	fl.StringSliceVar(&providers, "providers", nil, "provider ids")
	fl.StringVar(&budget, "budget", "", "budget amount (decimal)")
	fl.StringVar(&budgetCurrency, "budget-currency", "", "budget currency (ISO 4217)")
	fl.StringVar(&inputFile, "input", "", "candidate input text file; - reads stdin")
	fl.StringVar(&generationFile, "generation", "", "GenerationRequest JSON file; - reads stdin")
	addFilterFlags(save, &ff)

	show := a.idCmd("show <criteria-id>", "One saved criteria (restoring runs no queries)", "criteria id", criteriaView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.GetCriteria(ctx, id)
		})
	del := a.idCmd("delete <criteria-id>", "Delete saved criteria", "criteria id", plainView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.DeleteCriteria(ctx, id)
		})
	return group("criteria", "Saved filters and generation settings", list, save, show, del)
}

func (a *App) presetsCmd() *cobra.Command {
	var lp pageFlags
	list := a.newCmd("list", "Built-in and saved extension presets", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, lp, presetView, func(cursor *string, limit *int) callFn {
				p := api.ListPresetsParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListPresets(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)

	var name string
	var tlds []string
	save := a.newCmd("save", "Save an extension preset", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if name == "" || len(tlds) == 0 {
				return usageErr("--name and --tlds are required")
			}
			body := api.ExtensionPresetCreate{Name: name, Extensions: suffixes(tlds)}
			return a.show(ctx, presetView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreatePreset(ctx, body)
			})
		})
	save.Flags().StringVar(&name, "name", "", "preset name (required)")
	save.Flags().StringSliceVar(&tlds, "tlds", nil, "extensions, e.g. com,io,dev (required)")

	del := a.newCmd("delete <preset-id>", "Delete a saved extension preset", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.DeletePreset(ctx, args[0])
			})
		})
	return group("presets", "Extension presets", list, save, del)
}

func (a *App) generateCmd() *cobra.Command {
	var (
		roots, themes, prefixes, affixes, strategies, exclude, tlds []string
		minLength, maxLength, limit, seed                           int
		allowDigits, allowHyphens, listThemes, scan, wait           bool
		label, key                                                  string
	)
	cmd := a.newCmd("generate [roots...]", "Generate candidates locally (no network); --scan submits the valid ones", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if listThemes {
				return a.show(ctx, themeView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
					return g.ListGenerationThemes(ctx)
				})
			}
			if wait && !scan {
				return usageErr("--wait applies only with --scan")
			}
			body := api.GenerationRequestInput{
				Roots:      optSlice(append(append([]string{}, args...), roots...)),
				Themes:     optSlice(themes),
				Prefixes:   optSlice(prefixes),
				Suffixes:   optSlice(affixes),
				Extensions: optSlice(suffixes(tlds)),
			}
			if len(strategies) > 0 {
				ss := make([]api.GenerationStrategy, len(strategies))
				for i, s := range strategies {
					ss[i] = api.GenerationStrategy(s)
					if !ss[i].Valid() {
						return usageErr("unknown --strategies value %q: use roots, affixes, compounds, syllables, mutations or hacks", s)
					}
				}
				body.Strategies = &ss
			}
			fl := cmd.Flags()
			if fl.Changed("min-length") || fl.Changed("max-length") || allowDigits || allowHyphens || len(exclude) > 0 {
				body.Rules = &struct {
					AllowDigits  *bool     `json:"allowDigits,omitempty"`
					AllowHyphens *bool     `json:"allowHyphens,omitempty"`
					Exclude      *[]string `json:"exclude,omitempty"`
					MaxLength    *int      `json:"maxLength,omitempty"`
					MinLength    *int      `json:"minLength,omitempty"`
				}{AllowDigits: ptr(allowDigits), AllowHyphens: ptr(allowHyphens), Exclude: optSlice(exclude)}
				if fl.Changed("min-length") {
					body.Rules.MinLength = ptr(minLength)
				}
				if fl.Changed("max-length") {
					body.Rules.MaxLength = ptr(maxLength)
				}
			}
			if fl.Changed("limit") {
				body.Limit = ptr(limit)
			}
			if fl.Changed("seed") {
				body.Seed = ptr(seed)
			}
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PreviewGeneration(ctx, body)
			})
			if err != nil {
				return err
			}
			if !scan {
				return a.emit(res.body, generationView)
			}
			var preview api.GenerationPreviewResponse
			if err := json.Unmarshal(res.body, &preview); err != nil {
				return failErr("backend returned a malformed generation preview: %v", err)
			}
			var names []string
			for _, cand := range preview.Data.Candidates {
				if !cand.Valid {
					continue
				}
				if cand.Domain != nil && *cand.Domain != "" {
					names = append(names, *cand.Domain)
				} else {
					names = append(names, cand.Name)
				}
			}
			if len(names) == 0 {
				return usageErr("no valid candidates to scan")
			}
			a.progress("Generated %d candidates; submitting %d valid ones for registry checks.", len(preview.Data.Candidates), len(names))
			src := api.InputSourceInput{Domains: &names, Extensions: optSlice(preview.Data.Extensions)}
			var job api.CreateJobRequestInput
			if err := job.FromScanJobRequestInput(api.ScanJobRequestInput{
				Type: api.ScanJobRequestInputTypeRegistryScan, Label: optStr(label), Input: src,
			}); err != nil {
				return failErr("cannot encode the scan: %v", err)
			}
			k := keyOrNew(key)
			return a.submit(ctx, wait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateJob(ctx, &api.CreateJobParams{IdempotencyKey: &k}, job)
			})
		})
	fl := cmd.Flags()
	fl.StringSliceVar(&roots, "roots", nil, "root words (also accepted as arguments)")
	fl.StringSliceVar(&themes, "themes", nil, "bundled theme ids (see --list-themes)")
	fl.StringSliceVar(&prefixes, "prefixes", nil, "prefixes to combine")
	fl.StringSliceVar(&affixes, "suffixes", nil, "word suffixes to combine (not extensions)")
	fl.StringSliceVar(&strategies, "strategies", nil, "roots, affixes, compounds, syllables, mutations, hacks")
	fl.IntVar(&minLength, "min-length", 3, "minimum label length")
	fl.IntVar(&maxLength, "max-length", 15, "maximum label length")
	fl.BoolVar(&allowDigits, "allow-digits", false, "allow digits")
	fl.BoolVar(&allowHyphens, "allow-hyphens", false, "allow hyphens")
	fl.StringSliceVar(&exclude, "exclude", nil, "substrings to exclude")
	fl.StringSliceVar(&tlds, "tlds", nil, "extensions to expand candidates with")
	fl.IntVar(&limit, "limit", 300, "maximum candidates")
	fl.IntVar(&seed, "seed", 0, "deterministic seed for syllable generation")
	fl.BoolVar(&listThemes, "list-themes", false, "list bundled themes instead of generating")
	fl.BoolVar(&scan, "scan", false, "submit a registry scan of the valid candidates")
	fl.BoolVar(&wait, "wait", false, "with --scan: wait and print all results")
	fl.StringVar(&label, "label", "", "with --scan: job label")
	idempotencyFlag(cmd, &key)
	return cmd
}
