package cli

import (
	"context"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

func ptr[T any](v T) *T { return &v }

// optStr returns nil for an empty string.
func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func optSlice[T any](s []T) *[]T {
	if len(s) == 0 {
		return nil
	}
	return &s
}

func parseID(s, what string) (api.Uuid, error) {
	id, err := uuid.Parse(strings.TrimSpace(s))
	if err != nil {
		return api.Uuid{}, usageErr("%s %q is not a valid id (UUID expected)", what, s)
	}
	return id, nil
}

func parseIDs(list []string, what string) ([]api.Uuid, error) {
	out := make([]api.Uuid, 0, len(list))
	for _, s := range list {
		id, err := parseID(s, what)
		if err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, nil
}

// readSource reads a file, or stdin for "-". Stdin is only read when asked.
func (a *App) readSource(path string) (string, error) {
	if path == "-" {
		b, err := io.ReadAll(a.Stdin)
		if err != nil {
			return "", failErr("cannot read stdin: %v", err)
		}
		return string(b), nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", failErr("cannot read %s: %v", path, err)
	}
	return string(b), nil
}

// splitList splits file content on newlines, commas and whitespace, dropping
// blanks and # comments.
func splitList(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if i := strings.Index(line, "#"); i >= 0 {
			line = line[:i]
		}
		for _, f := range strings.FieldsFunc(line, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\r' }) {
			out = append(out, f)
		}
	}
	return out
}

// names collects positional values plus an optional --file list.
func (a *App) names(args []string, file string) ([]string, error) {
	out := append([]string{}, args...)
	if file != "" {
		text, err := a.readSource(file)
		if err != nil {
			return nil, err
		}
		out = append(out, splitList(text)...)
	}
	return out, nil
}

// domains is names() with light normalization: trim, lower case, no
// trailing dot. The backend performs full validation.
func (a *App) domains(args []string, file string) ([]string, error) {
	raw, err := a.names(args, file)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(raw))
	seen := map[string]bool{}
	for _, d := range raw {
		d = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(d)), ".")
		if d == "" || seen[d] {
			continue
		}
		seen[d] = true
		out = append(out, d)
	}
	if len(out) == 0 {
		return nil, usageErr("no domains given: pass them as arguments or with --file (use - for stdin)")
	}
	return out, nil
}

// suffixes normalizes --tlds values (".com" and "COM" become "com").
func suffixes(list []string) []string {
	out := make([]string, 0, len(list))
	for _, s := range list {
		s = strings.Trim(strings.ToLower(strings.TrimSpace(s)), ".")
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// pageFlags are --cursor, --limit and --all for paginated lists.
type pageFlags struct {
	cursor string
	limit  int
	all    bool
}

func addPageFlags(cmd *cobra.Command, p *pageFlags) {
	cmd.Flags().StringVar(&p.cursor, "cursor", "", "continue from this page cursor")
	cmd.Flags().IntVar(&p.limit, "limit", 0, "page size (default: the API default)")
	cmd.Flags().BoolVar(&p.all, "all", false, "follow every page and print one combined envelope")
}

func (p pageFlags) limitPtr() *int {
	if p.limit <= 0 {
		return nil
	}
	return &p.limit
}

// list prints one page, or every page with --all.
func (a *App) list(ctx context.Context, p pageFlags, v view, fn func(cursor *string, limit *int) callFn) error {
	if p.limit < 0 {
		return usageErr("--limit must be positive")
	}
	c, err := a.api(ctx)
	if err != nil {
		return err
	}
	if p.all {
		body, err := c.all(ctx, optStr(p.cursor), func(cursor *string) callFn { return fn(cursor, p.limitPtr()) })
		if err != nil {
			return err
		}
		return a.emit(body, v)
	}
	res, err := c.do(ctx, fn(optStr(p.cursor), p.limitPtr()))
	if err != nil {
		return err
	}
	return a.emit(res.body, v)
}

// show prints the response of a single request.
func (a *App) show(ctx context.Context, v view, fn callFn) error {
	c, err := a.api(ctx)
	if err != nil {
		return err
	}
	res, err := c.do(ctx, fn)
	if err != nil {
		return err
	}
	return a.emit(res.body, v)
}

// filterFlags expose ResultFilter, the one filter/sort specification shared
// by result views, exports and saved criteria.
type filterFlags struct {
	q             string
	outcomes      []string
	suffixes      []string
	states        []string
	resolved      string
	confirmations []string
	maxPrice      string
	priceCurrency string
	maxLength     int
	collection    string
	sort          string
	order         string
}

func addFilterFlags(cmd *cobra.Command, f *filterFlags) {
	fl := cmd.Flags()
	fl.StringVar(&f.q, "q", "", "substring match on the domain or name")
	fl.StringSliceVar(&f.outcomes, "outcomes", nil, "outcomes, e.g. no_record,registered,inconclusive")
	fl.StringSliceVar(&f.suffixes, "suffixes", nil, "registration suffixes, e.g. com,co.uk")
	fl.StringSliceVar(&f.states, "states", nil, "item states: pending,running,finished,interrupted")
	fl.StringVar(&f.resolved, "resolved", "", "true or false")
	fl.StringSliceVar(&f.confirmations, "confirmations", nil, "provider confirmations: available,unavailable,restricted,unknown")
	fl.StringVar(&f.maxPrice, "max-price", "", "maximum known first-year price (decimal)")
	fl.StringVar(&f.priceCurrency, "price-currency", "", "currency for --max-price (ISO 4217)")
	fl.IntVar(&f.maxLength, "max-length", 0, "maximum label length")
	fl.StringVar(&f.collection, "collection", "", "only items in this shortlist id")
	fl.StringVar(&f.sort, "sort", "", "input, domain, suffix, length, outcome, checkedAt or price")
	fl.StringVar(&f.order, "order", "", "asc or desc")
}

var decimalRe = regexp.MustCompile(`^-?\d+(\.\d+)?$`)
var currencyRe = regexp.MustCompile(`^[A-Z]{3}$`)

func (f *filterFlags) validate() error {
	if f.resolved != "" && f.resolved != "true" && f.resolved != "false" {
		return usageErr("--resolved must be true or false")
	}
	for _, s := range f.states {
		if !api.ItemState(s).Valid() {
			return usageErr("invalid --states value %q", s)
		}
	}
	for _, s := range f.confirmations {
		if !api.ConfirmationStatus(s).Valid() {
			return usageErr("invalid --confirmations value %q", s)
		}
	}
	if f.maxPrice != "" && !decimalRe.MatchString(f.maxPrice) {
		return usageErr("--max-price must be a decimal amount such as 12.99")
	}
	if f.priceCurrency != "" && !currencyRe.MatchString(f.priceCurrency) {
		return usageErr("--price-currency must be an ISO 4217 code such as USD")
	}
	if f.maxLength < 0 || f.maxLength > 63 {
		return usageErr("--max-length must be between 1 and 63")
	}
	if f.collection != "" {
		if _, err := parseID(f.collection, "--collection"); err != nil {
			return err
		}
	}
	if f.sort != "" && !api.ResultSort(f.sort).Valid() {
		return usageErr("invalid --sort %q: use input, domain, suffix, length, outcome, checkedAt or price", f.sort)
	}
	if f.order != "" && f.order != "asc" && f.order != "desc" {
		return usageErr("--order must be asc or desc")
	}
	return nil
}

func (f *filterFlags) set() bool {
	return f.q != "" || len(f.outcomes) > 0 || len(f.suffixes) > 0 || len(f.states) > 0 || f.resolved != "" ||
		len(f.confirmations) > 0 || f.maxPrice != "" || f.priceCurrency != "" || f.maxLength > 0 ||
		f.collection != "" || f.sort != "" || f.order != ""
}

func joinOpt(list []string) *string {
	if len(list) == 0 {
		return nil
	}
	s := strings.Join(list, ",")
	return &s
}

// params renders the query-string form for GET /jobs/:id/results.
func (f *filterFlags) params() api.ListJobResultsParams {
	p := api.ListJobResultsParams{
		Q:             optStr(f.q),
		Outcomes:      joinOpt(f.outcomes),
		Suffixes:      joinOpt(suffixes(f.suffixes)),
		States:        joinOpt(f.states),
		Confirmations: joinOpt(f.confirmations),
		MaxPrice:      optStr(f.maxPrice),
		PriceCurrency: optStr(f.priceCurrency),
		CollectionId:  optStr(f.collection),
	}
	if f.resolved != "" {
		p.Resolved = ptr(api.ListJobResultsParamsResolved(f.resolved))
	}
	if f.maxLength > 0 {
		p.MaxLength = ptr(f.maxLength)
	}
	if f.sort != "" {
		p.Sort = ptr(api.ResultSort(f.sort))
	}
	if f.order != "" {
		p.Order = ptr(api.ListJobResultsParamsOrder(f.order))
	}
	return p
}

// filter renders the structured ResultFilter body form.
func (f *filterFlags) filter() api.ResultFilterInput {
	r := api.ResultFilterInput{
		Q:             optStr(f.q),
		Outcomes:      optSlice(f.outcomes),
		Suffixes:      optSlice(suffixes(f.suffixes)),
		MaxPrice:      optStr(f.maxPrice),
		PriceCurrency: optStr(f.priceCurrency),
	}
	if len(f.states) > 0 {
		states := make([]api.ItemState, len(f.states))
		for i, s := range f.states {
			states[i] = api.ItemState(s)
		}
		r.States = &states
	}
	if len(f.confirmations) > 0 {
		cs := make([]api.ConfirmationStatus, len(f.confirmations))
		for i, s := range f.confirmations {
			cs[i] = api.ConfirmationStatus(s)
		}
		r.Confirmations = &cs
	}
	if f.resolved != "" {
		r.Resolved = ptr(f.resolved == "true")
	}
	if f.maxLength > 0 {
		r.MaxLength = ptr(f.maxLength)
	}
	if f.collection != "" {
		id, _ := uuid.Parse(f.collection)
		r.CollectionId = &id
	}
	if f.sort != "" {
		r.Sort = ptr(api.ResultSort(f.sort))
	}
	if f.order != "" {
		r.Order = ptr(api.ResultFilterInputOrder(f.order))
	}
	return r
}

// scopeFlags select an explicit export or snapshot scope.
type scopeFlags struct {
	scope       string
	items       []string
	job         string
	shortlist   string
	domains     []string
	domainsFile string
	filter      filterFlags
}

func addScopeFlags(cmd *cobra.Command, s *scopeFlags) {
	fl := cmd.Flags()
	fl.StringVar(&s.scope, "scope", "", "selection, filter, job, collection, domains or all (required)")
	fl.StringSliceVar(&s.items, "items", nil, "item ids (scope selection)")
	fl.StringVar(&s.job, "job", "", "job id (scope job or filter)")
	fl.StringVar(&s.shortlist, "shortlist", "", "shortlist id (scope collection)")
	fl.StringSliceVar(&s.domains, "domains", nil, "domains (scope domains)")
	fl.StringVar(&s.domainsFile, "domains-file", "", "file with domains, - for stdin (scope domains)")
	addFilterFlags(cmd, &s.filter)
}

// build validates that exactly the selectors matching --scope are present
// and returns the ExportScope body.
func (s *scopeFlags) build(a *App) (api.ExportScopeInput, error) {
	var out api.ExportScopeInput
	present := []struct {
		name string
		set  bool
	}{
		{"--items", len(s.items) > 0},
		{"--job", s.job != ""},
		{"--shortlist", s.shortlist != ""},
		{"--domains", len(s.domains) > 0 || s.domainsFile != ""},
		{"filter flags", s.filter.set()},
	}
	allowed := map[string][]string{
		"selection":  {"--items"},
		"filter":     {"--job", "filter flags"},
		"job":        {"--job"},
		"collection": {"--shortlist"},
		"domains":    {"--domains"},
		"all":        {},
	}
	ok, known := allowed[s.scope]
	if !known {
		if s.scope == "" {
			return out, usageErr("--scope is required: selection, filter, job, collection, domains or all")
		}
		return out, usageErr("invalid --scope %q: use selection, filter, job, collection, domains or all", s.scope)
	}
	for _, p := range present {
		if p.set && !slices.Contains(ok, p.name) {
			return out, usageErr("%s does not apply to --scope %s", p.name, s.scope)
		}
	}
	var err error
	switch s.scope {
	case "selection":
		if len(s.items) == 0 {
			return out, usageErr("--scope selection requires --items")
		}
		ids, perr := parseIDs(s.items, "--items")
		if perr != nil {
			return out, perr
		}
		err = out.FromSelectionScope(api.SelectionScope{Kind: api.Selection, ItemIds: ids})
	case "filter":
		if s.job == "" {
			return out, usageErr("--scope filter requires --job and filter flags")
		}
		if verr := s.filter.validate(); verr != nil {
			return out, verr
		}
		id, perr := parseID(s.job, "--job")
		if perr != nil {
			return out, perr
		}
		err = out.FromFilterScopeInput(api.FilterScopeInput{Kind: api.FilterScopeInputKindFilter, JobId: id, Filter: s.filter.filter()})
	case "job":
		if s.job == "" {
			return out, usageErr("--scope job requires --job")
		}
		id, perr := parseID(s.job, "--job")
		if perr != nil {
			return out, perr
		}
		err = out.FromJobScope(api.JobScope{Kind: api.JobScopeKindJob, JobId: id})
	case "collection":
		if s.shortlist == "" {
			return out, usageErr("--scope collection requires --shortlist")
		}
		id, perr := parseID(s.shortlist, "--shortlist")
		if perr != nil {
			return out, perr
		}
		err = out.FromCollectionScope(api.CollectionScope{Kind: api.CollectionScopeKindCollection, CollectionId: id})
	case "domains":
		if len(s.domains) == 0 && s.domainsFile == "" {
			return out, usageErr("--scope domains requires --domains or --domains-file")
		}
		ds, derr := a.domains(s.domains, s.domainsFile)
		if derr != nil {
			return out, derr
		}
		err = out.FromDomainsScope(api.DomainsScope{Kind: api.Domains, Domains: ds})
	case "all":
		err = out.FromAllScope(api.AllScope{Kind: api.All})
	}
	if err != nil {
		return out, failErr("cannot encode the scope: %v", err)
	}
	return out, nil
}

// idempotencyFlag adds --idempotency-key; an empty value gets a random key so
// connection retries never duplicate a submission.
func idempotencyFlag(cmd *cobra.Command, key *string) {
	cmd.Flags().StringVar(key, "idempotency-key", "", "Idempotency-Key header; replaying the same key and body returns the original job")
}

func keyOrNew(key string) string {
	if key != "" {
		return key
	}
	return newIdempotencyKey()
}
