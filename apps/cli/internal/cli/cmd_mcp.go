package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

func (a *App) mcpCmd() *cobra.Command {
	cmd := a.newCmd("mcp", "Serve Domain Scout tools over MCP stdio", cobra.NoArgs,
		func(ctx context.Context, _ *cobra.Command, _ []string) error {
			return a.mcpServer().Run(ctx, &mcp.IOTransport{
				Reader: io.NopCloser(a.Stdin), Writer: mcpWriter{a.Stdout},
			})
		})
	cmd.Long = `Serve Model Context Protocol tools over stdio for coding agents.
Tools use the same local HTTP API, runtime discovery and automatic backend
startup as other commands. stdout carries MCP messages only.
Scan sends names only to registry services. Quotes explicitly send exact
names to the selected providers. no_record means no registry record.`
	return cmd
}

// MCP owns the transport, not the process's stdout.
type mcpWriter struct{ io.Writer }

func (mcpWriter) Close() error { return nil }

type mcpAdapter struct {
	app *App
	// Tool calls may arrive concurrently; initialize the shared client once.
	mu sync.Mutex
	// Serializes find-or-create by shortlist name so concurrent adds share one list.
	shortlistMu sync.Mutex
}

func (a *mcpAdapter) client(ctx context.Context) (*apiClient, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.app.api(ctx)
}

type mcpPreviewInput struct {
	Text string   `json:"text" jsonschema:"Pasted names or input text to validate and expand"`
	TLDs []string `json:"tlds" jsonschema:"Suffixes for expanding base names, such as com or co.uk"`
}

type mcpScanInput struct {
	Names   []string `json:"names,omitempty" jsonschema:"Names to scan; supply either names or text"`
	Text    *string  `json:"text,omitempty" jsonschema:"Input text to scan; supply either text or names"`
	TLDs    []string `json:"tlds" jsonschema:"Suffixes for expanding base names"`
	Label   *string  `json:"label,omitempty" jsonschema:"Optional job label"`
	Wait    *bool    `json:"wait,omitempty" jsonschema:"Wait for results; defaults to true"`
	Timeout *int     `json:"timeout,omitempty" jsonschema:"Maximum wait in seconds, 1 to 3600; defaults to 120"`
}

type mcpJobInput struct {
	JobID string `json:"job_id" jsonschema:"Job UUID"`
}

type mcpResultsInput struct {
	JobID    string   `json:"job_id" jsonschema:"Job UUID"`
	Outcomes []string `json:"outcomes,omitempty" jsonschema:"Outcome filters; no_record means no registry record"`
	Suffixes []string `json:"suffixes,omitempty" jsonschema:"Suffix filters"`
	MaxPrice *string  `json:"max_price,omitempty" jsonschema:"Maximum price as a decimal string"`
	Limit    *int     `json:"limit,omitempty" jsonschema:"Maximum rows, 1 to 1000; defaults to 100"`
	Cursor   *string  `json:"cursor,omitempty" jsonschema:"nextCursor from a previous page"`
}

type mcpDomainInput struct {
	Domain string `json:"domain" jsonschema:"Domain whose retained evidence should be read"`
}

type mcpPricesInput struct {
	Suffixes []string `json:"suffixes" jsonschema:"Suffixes whose published provider prices should be read"`
}

type mcpGenerateInput struct {
	Roots      []string `json:"roots" jsonschema:"Root words"`
	Themes     []string `json:"themes,omitempty" jsonschema:"Bundled local theme ids"`
	TLDs       []string `json:"tlds" jsonschema:"Suffixes for expanding generated candidates"`
	Strategies []string `json:"strategies,omitempty" jsonschema:"roots, affixes, compounds, syllables, mutations or hacks"`
	Limit      *int     `json:"limit,omitempty" jsonschema:"Maximum candidates, 1 to 5000; backend default is 300"`
}

type mcpShortlistInput struct {
	ShortlistID string   `json:"shortlist_id,omitempty" jsonschema:"Existing shortlist UUID; supply either shortlist_id or name"`
	Name        string   `json:"name,omitempty" jsonschema:"Shortlist name to find or create; supply either name or shortlist_id"`
	Domains     []string `json:"domains" jsonschema:"Domains to add without external queries"`
}

type mcpQuoteInput struct {
	Domains   []string `json:"domains" jsonschema:"Exact domain names to send to the listed providers"`
	Providers []string `json:"providers" jsonschema:"Explicit provider ids to receive these names"`
	Wait      *bool    `json:"wait,omitempty" jsonschema:"Wait for results; defaults to true"`
	Timeout   *int     `json:"timeout,omitempty" jsonschema:"Maximum wait in seconds, 1 to 3600; defaults to 120"`
}

type mcpCoverageInput struct {
	Suffix string `json:"suffix" jsonschema:"Suffix whose registry coverage should be read"`
}

func (a *App) mcpServer() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "domain-scout", Version: a.Version}, nil)
	adapter := &mcpAdapter{app: a}
	addMCPTool(s, adapter, "preview_input", "Validate and expand names locally through the backend, without external network queries.",
		func(ctx context.Context, c *apiClient, in mcpPreviewInput) (any, string, error) {
			return mcpCall(ctx, c, "Input validated and expanded without external queries.", func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PreviewInput(ctx, api.InputSourceInput{Text: &in.Text, Extensions: optSlice(suffixes(in.TLDs))})
			})
		})
	addMCPTool(s, adapter, "scan", "Submit a registry-only lookup. Names are sent only to registry services. no_record means no registry record, never guaranteed registration eligibility. Wait defaults to true with a 120 second timeout.",
		func(ctx context.Context, c *apiClient, in mcpScanInput) (any, string, error) {
			if (len(in.Names) == 0) == (in.Text == nil) {
				return nil, "", usageErr("supply exactly one of names or text")
			}
			var body api.CreateJobRequestInput
			err := body.FromScanJobRequestInput(api.ScanJobRequestInput{
				Type: api.ScanJobRequestInputTypeRegistryScan, Label: in.Label,
				Input: api.InputSourceInput{Domains: optSlice(in.Names), Text: in.Text, Extensions: optSlice(suffixes(in.TLDs))},
			})
			if err != nil {
				return nil, "", failErr("cannot encode scan: %v", err)
			}
			key := newIdempotencyKey()
			return adapter.submit(ctx, c, in.Wait, in.Timeout, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateJob(ctx, &api.CreateJobParams{IdempotencyKey: &key}, body)
			})
		})
	addMCPTool(s, adapter, "job_status", "Read a job's state, counters and destinations from the local API.",
		func(ctx context.Context, c *apiClient, in mcpJobInput) (any, string, error) {
			id, err := parseID(in.JobID, "job_id")
			if err != nil {
				return nil, "", err
			}
			return mcpCall(ctx, c, "Job status retrieved.", func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.GetJob(ctx, id) })
		})
	addMCPTool(s, adapter, "job_results", "Read filtered job results, default limit 100. no_record means no registry record; prices and registration eligibility remain separate evidence.",
		func(ctx context.Context, c *apiClient, in mcpResultsInput) (any, string, error) {
			id, err := parseID(in.JobID, "job_id")
			if err != nil {
				return nil, "", err
			}
			limit := 100
			if in.Limit != nil {
				limit = *in.Limit
			}
			if limit < 1 || limit > 1000 {
				return nil, "", usageErr("limit must be between 1 and 1000")
			}
			params := api.ListJobResultsParams{Outcomes: joinOpt(in.Outcomes), Suffixes: joinOpt(suffixes(in.Suffixes)), MaxPrice: in.MaxPrice, Limit: &limit, Cursor: in.Cursor}
			return mcpCall(ctx, c, "Job results retrieved. no_record means no registry record.", func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.ListJobResults(ctx, id, &params)
			})
		})
	addMCPTool(s, adapter, "domain_evidence", "Read retained registry evidence, offers and provider evidence for a domain, preserving sources and freshness. Does not trigger a lookup.",
		func(ctx context.Context, c *apiClient, in mcpDomainInput) (any, string, error) {
			return mcpCall(ctx, c, "Domain evidence retrieved; no registry record does not guarantee eligibility.", func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.GetDomainEvidence(ctx, in.Domain)
			})
		})
	addMCPTool(s, adapter, "suffix_prices", "Read published suffix prices per provider from GET /api/v1/prices. No candidate names are sent; these are not exact-name quotes.",
		func(ctx context.Context, c *apiClient, in mcpPricesInput) (any, string, error) {
			params := api.ListSuffixPricesParams{Suffixes: strings.Join(suffixes(in.Suffixes), ",")}
			return mcpCall(ctx, c, "Published suffix prices retrieved, with API sources and freshness.", func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.ListSuffixPrices(ctx, &params)
			})
		})
	addMCPTool(s, adapter, "generate_candidates", "Generate candidates locally in the backend without external network queries or an implicit scan.",
		func(ctx context.Context, c *apiClient, in mcpGenerateInput) (any, string, error) {
			strategies := make([]api.GenerationStrategy, len(in.Strategies))
			for i, value := range in.Strategies {
				strategies[i] = api.GenerationStrategy(value)
			}
			body := api.GenerationRequestInput{Roots: optSlice(in.Roots), Themes: optSlice(in.Themes), Extensions: optSlice(suffixes(in.TLDs)), Strategies: optSlice(strategies), Limit: in.Limit}
			return mcpCall(ctx, c, "Candidates generated without external queries.", func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PreviewGeneration(ctx, body)
			})
		})
	addMCPTool(s, adapter, "shortlist_list", "List all saved shortlists without external queries.",
		func(ctx context.Context, c *apiClient, _ struct{}) (any, string, error) {
			raw, err := mcpCollections(ctx, c)
			return json.RawMessage(raw), "Shortlists retrieved.", err
		})
	addMCPTool(s, adapter, "shortlist_add", "Add domains to a shortlist by id or name. Create the named shortlist if missing. Does not query external services.", adapter.shortlistAdd)
	addMCPTool(s, adapter, "quote", "Request exact-name quotes. This sends the exact names to the listed providers. Missing access remains credential_required, and unsupported or unknown prices remain explicit. Wait defaults to true with a 120 second timeout.",
		func(ctx context.Context, c *apiClient, in mcpQuoteInput) (any, string, error) {
			if len(in.Domains) == 0 || len(in.Providers) == 0 {
				return nil, "", usageErr("domains and providers must be nonempty")
			}
			body := api.ProviderJobBody{Domains: in.Domains, ProviderIds: in.Providers}
			key := newIdempotencyKey()
			return adapter.submit(ctx, c, in.Wait, in.Timeout, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateQuotes(ctx, &api.CreateQuotesParams{IdempotencyKey: &key}, body)
			})
		})
	addMCPTool(s, adapter, "coverage", "Read registry routing, provenance and tested versus discovered support for a suffix. Coverage is not a registration guarantee.",
		func(ctx context.Context, c *apiClient, in mcpCoverageInput) (any, string, error) {
			return mcpCall(ctx, c, "Suffix coverage retrieved.", func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.GetSuffixCoverage(ctx, in.Suffix)
			})
		})
	return s
}

func addMCPTool[In any](s *mcp.Server, a *mcpAdapter, name, description string, fn func(context.Context, *apiClient, In) (any, string, error)) {
	mcp.AddTool(s, &mcp.Tool{Name: name, Description: description}, func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		c, err := a.client(ctx)
		if err != nil {
			return mcpToolError(err), nil, nil
		}
		out, summary, err := fn(ctx, c, in)
		if err != nil {
			return mcpToolError(err), nil, nil
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: summary}}}, out, nil
	})
}

func mcpToolError(err error) *mcp.CallToolResult {
	e := classify(err)
	var out any = json.RawMessage(e.raw)
	if e.parsed == nil {
		out = localErrorEnvelope(e)
	}
	return &mcp.CallToolResult{IsError: true, StructuredContent: out, Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("%s: %s", e.errCode, e.msg)}}}
}

func mcpCall(ctx context.Context, c *apiClient, summary string, fn callFn) (any, string, error) {
	res, err := c.do(ctx, fn)
	if err != nil {
		return nil, "", err
	}
	if !json.Valid(res.body) {
		return nil, "", failErr("backend returned malformed JSON")
	}
	return json.RawMessage(res.body), summary, nil
}

const mcpWaitResults = 100

func (a *mcpAdapter) submit(ctx context.Context, c *apiClient, wait *bool, timeout *int, fn callFn) (any, string, error) {
	seconds := 120
	if timeout != nil {
		seconds = *timeout
	}
	if seconds < 1 || seconds > 3600 {
		return nil, "", usageErr("timeout must be between 1 and 3600 seconds")
	}
	res, err := c.doIdempotent(ctx, fn)
	if err != nil {
		return nil, "", err
	}
	var jr api.JobResponse
	if err := json.Unmarshal(res.body, &jr); err != nil {
		return nil, "", failErr("backend returned a malformed job: %v", err)
	}
	if wait != nil && !*wait {
		return json.RawMessage(res.body), fmt.Sprintf("Submitted job %s (%s).", jr.Data.Id, jr.Data.Type), nil
	}
	waitCtx, cancel := context.WithTimeout(ctx, time.Duration(seconds)*time.Second)
	defer cancel()
	timeoutResult := func(err error, jobRaw []byte) (any, string, error) {
		if ctx.Err() == nil && waitCtx.Err() == context.DeadlineExceeded {
			return map[string]any{"job": json.RawMessage(jobRaw), "timed_out": true}, fmt.Sprintf("Wait timed out after %d seconds. Job %s remains inspectable with job_status and job_results; it was not cancelled.", seconds, jr.Data.Id), nil
		}
		return nil, "", err
	}
	_, err = a.app.waitJob(waitCtx, c, jr.Data.Id, waitHooks{})
	if err != nil {
		return timeoutResult(err, res.body)
	}
	_, jobRaw, err := c.getJob(waitCtx, jr.Data.Id)
	if err != nil {
		return timeoutResult(err, res.body)
	}
	// One page keeps large scans out of the agent's context; job_results filters and pages the rest.
	limit := mcpWaitResults
	results, err := c.do(waitCtx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
		return g.ListJobResults(ctx, jr.Data.Id, &api.ListJobResultsParams{Limit: &limit})
	})
	if err != nil {
		return timeoutResult(err, jobRaw)
	}
	return map[string]any{"job": json.RawMessage(jobRaw), "results": json.RawMessage(results.body)}, fmt.Sprintf("Job %s finished. Results hold the first %d rows; use job_results with filters or nextCursor for more. Inspect outcomes, sources and freshness; no_record means no registry record and credential_required means provider access is missing.", jr.Data.Id, mcpWaitResults), nil
}

func mcpCollections(ctx context.Context, c *apiClient) ([]byte, error) {
	limit := 1000
	return c.all(ctx, nil, func(cursor *string) callFn {
		return func(ctx context.Context, g *api.Client) (*http.Response, error) {
			return g.ListCollections(ctx, &api.ListCollectionsParams{Cursor: cursor, Limit: &limit})
		}
	})
}

func (a *mcpAdapter) shortlistAdd(ctx context.Context, c *apiClient, in mcpShortlistInput) (any, string, error) {
	if (in.ShortlistID == "") == (in.Name == "") || len(in.Domains) == 0 {
		return nil, "", usageErr("supply domains and exactly one of shortlist_id or name")
	}
	var id api.Uuid
	if in.ShortlistID != "" {
		var err error
		id, err = parseID(in.ShortlistID, "shortlist_id")
		if err != nil {
			return nil, "", err
		}
	} else {
		a.shortlistMu.Lock()
		defer a.shortlistMu.Unlock()
		raw, err := mcpCollections(ctx, c)
		if err != nil {
			return nil, "", err
		}
		var collections api.CollectionListResponse
		if err := json.Unmarshal(raw, &collections); err != nil {
			return nil, "", failErr("backend returned malformed shortlists: %v", err)
		}
		for _, collection := range collections.Data {
			if collection.Name == in.Name {
				id = collection.Id
				break
			}
		}
		if id == (api.Uuid{}) {
			res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateCollection(ctx, api.CollectionCreate{Name: in.Name})
			})
			if err != nil {
				return nil, "", err
			}
			var created api.CollectionResponse
			if err := json.Unmarshal(res.body, &created); err != nil {
				return nil, "", failErr("backend returned a malformed shortlist: %v", err)
			}
			id = created.Data.Id
		}
	}
	return mcpCall(ctx, c, fmt.Sprintf("Domains added to shortlist %s.", id), func(ctx context.Context, g *api.Client) (*http.Response, error) {
		return g.AddCollectionEntries(ctx, id, api.CollectionEntriesAdd{Domains: in.Domains})
	})
}
