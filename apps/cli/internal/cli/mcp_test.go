package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func mcpTestClient(t *testing.T, f *fakeAPI) (*mcp.ClientSession, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	a := &App{
		Stdin: strings.NewReader(""), Stdout: io.Discard, Stderr: io.Discard,
		Getenv: func(key string) string {
			if key == EnvAPIToken {
				return testToken
			}
			return ""
		},
		GOOS: "linux", Home: t.TempDir(), Version: "test", PollInterval: 5 * time.Millisecond,
		opts: options{dataDir: filepath.Join(t.TempDir(), "data"), timeout: time.Second},
	}
	if f.srv != nil {
		a.opts.backendURL = f.srv.URL
	}
	ct, st := mcp.NewInMemoryTransports()
	ss, err := a.mcpServer().Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "test"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs, ctx
}

func callMCP(t *testing.T, ctx context.Context, c *mcp.ClientSession, name string, args any) *mcp.CallToolResult {
	t.Helper()
	res, err := c.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s protocol error: %v", name, err)
	}
	if len(res.Content) == 0 {
		t.Fatalf("%s has no text summary", name)
	}
	return res
}

func mcpStructured(t *testing.T, res *mcp.CallToolResult) map[string]any {
	t.Helper()
	b, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	return decodeJSON(t, string(b))
}

func assertMCPEnvelope(t *testing.T, res *mcp.CallToolResult, raw string) {
	t.Helper()
	if res.IsError {
		t.Fatalf("tool error: %v", res.Content)
	}
	if got, want := mcpStructured(t, res), decodeJSON(t, raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("structured content = %#v, want %#v", got, want)
	}
}

func TestMCPToolList(t *testing.T) {
	f := &fakeAPI{}
	c, ctx := mcpTestClient(t, f)
	list, err := c.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantRequired := map[string][]string{
		"preview_input": {"text", "tlds"}, "scan": {"tlds"}, "job_status": {"job_id"},
		"job_results": {"job_id"}, "domain_evidence": {"domain"}, "suffix_prices": {"suffixes"},
		"generate_candidates": {"roots", "tlds"}, "shortlist_list": {}, "shortlist_add": {"domains"},
		"quote": {"domains", "providers"}, "coverage": {"suffix"},
	}
	if len(list.Tools) != len(wantRequired) {
		t.Fatalf("got %d tools, want %d", len(list.Tools), len(wantRequired))
	}
	for _, tool := range list.Tools {
		want, ok := wantRequired[tool.Name]
		if !ok || tool.Description == "" {
			t.Fatalf("unexpected or undescribed tool: %#v", tool)
		}
		b, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		schema := decodeJSON(t, string(b))
		if schema["type"] != "object" {
			t.Fatalf("%s schema is not an object: %s", tool.Name, b)
		}
		var required []string
		for _, name := range sliceAny(schema["required"]) {
			required = append(required, name.(string))
		}
		sort.Strings(required)
		sort.Strings(want)
		if strings.Join(required, ",") != strings.Join(want, ",") {
			t.Errorf("%s required %v, want %v", tool.Name, required, want)
		}
		if tool.Name != "shortlist_list" {
			props, ok := schema["properties"].(map[string]any)
			if !ok || len(props) == 0 {
				t.Errorf("%s has no schema properties", tool.Name)
			}
			for name, property := range props {
				if property.(map[string]any)["type"] == nil {
					t.Errorf("%s.%s has no schema type", tool.Name, name)
				}
			}
		}
	}
	if f.count() != 0 {
		t.Fatal("listing tools should not connect to the backend")
	}
}

func sliceAny(v any) []any {
	if v == nil {
		return nil
	}
	return v.([]any)
}

func TestMCPPreviewAndScan(t *testing.T) {
	f := newFakeAPI(t)
	preview := envelope(`{"domains":["example.com"],"counts":{"valid":1}}`)
	job := envelope(jobJSON(jobSpec{state: "queued", total: 1}))
	f.reply("POST", "/api/v1/inputs/preview", 200, preview)
	f.reply("POST", "/api/v1/jobs", 201, job)
	c, ctx := mcpTestClient(t, f)
	res := callMCP(t, ctx, c, "preview_input", map[string]any{"text": "example", "tlds": []string{"com"}})
	assertMCPEnvelope(t, res, preview)
	reqs := f.requests("POST", "/api/v1/inputs/preview")
	want := map[string]any{"text": "example", "extensions": []any{"com"}}
	if len(reqs) != 1 || !reflect.DeepEqual(decodeJSON(t, string(reqs[0].body)), want) {
		t.Fatalf("preview requests: %#v", reqs)
	}
	for _, input := range []map[string]any{
		{"names": []string{"example"}, "tlds": []string{"com"}, "label": "MCP scan", "wait": false},
		{"text": "example", "tlds": []string{"com"}, "label": "MCP scan", "wait": false},
	} {
		res := callMCP(t, ctx, c, "scan", input)
		assertMCPEnvelope(t, res, job)
	}
	reqs = f.requests("POST", "/api/v1/jobs")
	if len(reqs) != 2 {
		t.Fatalf("scan requests = %d", len(reqs))
	}
	for i, req := range reqs {
		if req.header.Get("X-Domain-Scout-Client") != "cli" || req.header.Get("Idempotency-Key") == "" {
			t.Errorf("scan missing CLI header or idempotency key: %v", req.header)
		}
		input := map[string]any{"extensions": []any{"com"}}
		if i == 0 {
			input["domains"] = []any{"example"}
		} else {
			input["text"] = "example"
		}
		want := map[string]any{"type": "registry_scan", "label": "MCP scan", "input": input}
		if got := decodeJSON(t, string(req.body)); !reflect.DeepEqual(got, want) {
			t.Errorf("scan body %#v, want %#v", got, want)
		}
	}
}

func TestMCPJobResultsFilters(t *testing.T) {
	f := newFakeAPI(t)
	body := page([]string{itemJSON("example.com", "no_record", true)}, "next-page")
	f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, body)
	c, ctx := mcpTestClient(t, f)
	res := callMCP(t, ctx, c, "job_results", map[string]any{
		"job_id": jobID, "outcomes": []string{"no_record", "registered"}, "suffixes": []string{"com", "co.uk"}, "max_price": "12.50", "limit": 25,
	})
	assertMCPEnvelope(t, res, body)
	reqs := f.requests("GET", "/api/v1/jobs/"+jobID+"/results")
	for key, want := range map[string]string{"outcomes": "no_record,registered", "suffixes": "com,co.uk", "maxPrice": "12.50", "limit": "25"} {
		if got := reqs[0].query.Get(key); got != want {
			t.Errorf("query %s = %q, want %q", key, got, want)
		}
	}
	res = callMCP(t, ctx, c, "job_results", map[string]any{"job_id": jobID})
	assertMCPEnvelope(t, res, body)
	if got := f.requests("GET", "/api/v1/jobs/"+jobID+"/results")[1].query.Get("limit"); got != "100" {
		t.Fatalf("default limit = %q", got)
	}
}

func TestMCPQuoteCredentialError(t *testing.T) {
	f := newFakeAPI(t)
	body := errJSON("credential_required", "Configure provider credentials")
	f.reply("POST", "/api/v1/quotes", 409, body)
	c, ctx := mcpTestClient(t, f)
	res := callMCP(t, ctx, c, "quote", map[string]any{"domains": []string{"example.com"}, "providers": []string{"porkbun"}})
	if !res.IsError {
		t.Fatal("API 409 must be a tool error")
	}
	if !reflect.DeepEqual(mcpStructured(t, res), decodeJSON(t, body)) {
		t.Fatalf("lost API ErrorResponse: %#v", res.StructuredContent)
	}
	if text := res.Content[0].(*mcp.TextContent).Text; !strings.Contains(text, "credential_required") || !strings.Contains(text, "Configure provider credentials") {
		t.Fatalf("lost error code or message: %q", text)
	}
	reqs := f.requests("POST", "/api/v1/quotes")
	want := map[string]any{"domains": []any{"example.com"}, "providerIds": []any{"porkbun"}}
	if len(reqs) != 1 || !reflect.DeepEqual(decodeJSON(t, string(reqs[0].body)), want) {
		t.Fatalf("quote requests: %#v", reqs)
	}
}

func TestMCPWaitedJobsPreserveOutcomes(t *testing.T) {
	for _, name := range []string{"scan", "quote"} {
		t.Run(name, func(t *testing.T) {
			f := newFakeAPI(t)
			job := envelope(jobJSON(jobSpec{state: "completed_with_errors", total: 2, finished: 2, unresolv: 1, outcomes: `{"no_record":1,"credential_required":1}`}))
			path := "/api/v1/jobs"
			args := map[string]any{"names": []string{"example.com"}, "tlds": []string{}}
			if name == "quote" {
				path = "/api/v1/quotes"
				args = map[string]any{"domains": []string{"example.com"}, "providers": []string{"porkbun"}}
			}
			f.reply("POST", path, 201, job)
			f.reply("GET", "/api/v1/jobs/"+jobID, 200, job)
			f.on("GET", "/api/v1/events", sseHandler())
			rows := []string{itemJSON("example.com", "no_record", true), itemJSON("google.com", "credential_required", false)}
			f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, page(rows, ""))
			c, ctx := mcpTestClient(t, f)
			res := callMCP(t, ctx, c, name, args)
			if res.IsError {
				t.Fatal("per-item unresolved outcomes should remain data")
			}
			out := mcpStructured(t, res)
			if !reflect.DeepEqual(out["job"], decodeJSON(t, job)) || len(out["results"].(map[string]any)["data"].([]any)) != 2 {
				t.Fatalf("waited structured content: %#v", out)
			}
			if strings.Contains(strings.ToLower(res.Content[0].(*mcp.TextContent).Text), "available") {
				t.Fatal("summary misrepresents no_record")
			}
		})
	}
}

func TestMCPWaitTimeoutAndValidation(t *testing.T) {
	f := newFakeAPI(t)
	job := envelope(jobJSON(jobSpec{state: "running", total: 1}))
	f.reply("POST", "/api/v1/jobs", 201, job)
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, job)
	f.on("GET", "/api/v1/events", sseHandler())
	c, ctx := mcpTestClient(t, f)
	start := time.Now()
	res := callMCP(t, ctx, c, "scan", map[string]any{"names": []string{"example.com"}, "tlds": []string{}, "timeout": 1})
	out := mcpStructured(t, res)
	if res.IsError || out["timed_out"] != true || !reflect.DeepEqual(out["job"], decodeJSON(t, job)) || time.Since(start) > 3*time.Second {
		t.Fatalf("timeout did not preserve submitted job: %#v", out)
	}
	if len(f.requests("POST", "/api/v1/jobs/"+jobID+"/cancel")) != 0 {
		t.Fatal("wait timeout cancelled backend job")
	}
	for _, args := range []map[string]any{
		{"names": []string{"example.com"}, "text": "google.com", "tlds": []string{}},
		{"names": []string{"example.com"}, "tlds": []string{}, "timeout": 0},
		{"names": []string{"example.com"}, "tlds": []string{}, "timeout": 3601},
	} {
		res := callMCP(t, ctx, c, "scan", args)
		if !res.IsError {
			t.Fatal("invalid scan should be a tool error")
		}
		// Local errors carry the full API ErrorResponse shape, like backend errors.
		e, _ := mcpStructured(t, res)["error"].(map[string]any)
		for _, key := range []string{"code", "message", "requestId", "domain", "source", "retryable", "retryAt", "details"} {
			if _, ok := e[key]; !ok {
				t.Fatalf("local error envelope missing %q: %#v", key, e)
			}
		}
	}
	if len(f.requests("POST", "/api/v1/jobs")) != 1 {
		t.Fatal("invalid scan reached submission endpoint")
	}
}

func TestMCPReadAndGenerateEndpoints(t *testing.T) {
	f := newFakeAPI(t)
	body := envelope(`{"retained":true}`)
	for _, path := range []string{"/api/v1/jobs/" + jobID, "/api/v1/domains/example.com/evidence", "/api/v1/prices", "/api/v1/coverage/com"} {
		f.reply("GET", path, 200, body)
	}
	f.reply("POST", "/api/v1/generation/preview", 200, body)
	c, ctx := mcpTestClient(t, f)
	for name, args := range map[string]any{
		"job_status": map[string]any{"job_id": jobID}, "domain_evidence": map[string]any{"domain": "example.com"},
		"suffix_prices": map[string]any{"suffixes": []string{"com", "co.uk"}}, "coverage": map[string]any{"suffix": "com"},
		"generate_candidates": map[string]any{"roots": []string{"example"}, "themes": []string{"nature"}, "tlds": []string{"com"}, "strategies": []string{"roots"}, "limit": 20},
	} {
		assertMCPEnvelope(t, callMCP(t, ctx, c, name, args), body)
	}
	if got := f.requests("GET", "/api/v1/prices")[0].query.Get("suffixes"); got != "com,co.uk" {
		t.Fatalf("suffix prices query: %q", got)
	}
	want := map[string]any{"roots": []any{"example"}, "themes": []any{"nature"}, "extensions": []any{"com"}, "strategies": []any{"roots"}, "limit": float64(20)}
	if got := decodeJSON(t, string(f.requests("POST", "/api/v1/generation/preview")[0].body)); !reflect.DeepEqual(got, want) {
		t.Fatalf("generation body: %#v", got)
	}
}

func TestMCPShortlists(t *testing.T) {
	for _, mode := range []string{"id", "existing_name", "new_name"} {
		t.Run(mode, func(t *testing.T) {
			f := newFakeAPI(t)
			collection := `{"id":"` + jobID + `","name":"Research","entryCount":0}`
			f.on("GET", "/api/v1/collections", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("cursor") == "page-2" {
					writeRaw(w, 200, page([]string{collection}, ""))
				} else {
					writeRaw(w, 200, page(nil, "page-2"))
				}
			})
			f.reply("POST", "/api/v1/collections", 201, envelope(collection))
			body := envelope(`{"added":["example.com"]}`)
			f.reply("POST", "/api/v1/collections/"+jobID+"/entries", 200, body)
			c, ctx := mcpTestClient(t, f)
			listed := callMCP(t, ctx, c, "shortlist_list", map[string]any{})
			if listed.IsError || len(mcpStructured(t, listed)["data"].([]any)) != 1 {
				t.Fatal("shortlist_list did not follow pagination")
			}
			args := map[string]any{"domains": []string{"example.com"}}
			if mode == "id" {
				args["shortlist_id"] = jobID
			} else if mode == "existing_name" {
				args["name"] = "Research"
			} else {
				args["name"] = "New research"
			}
			assertMCPEnvelope(t, callMCP(t, ctx, c, "shortlist_add", args), body)
			created := f.requests("POST", "/api/v1/collections")
			if (mode == "new_name" && len(created) != 1) || (mode != "new_name" && len(created) != 0) {
				t.Fatalf("unexpected creation requests: %#v", created)
			}
			if mode == "new_name" && decodeJSON(t, string(created[0].body))["name"] != "New research" {
				t.Fatal("incorrect creation name")
			}
			req := f.requests("POST", "/api/v1/collections/"+jobID+"/entries")[0]
			if got := decodeJSON(t, string(req.body)); !reflect.DeepEqual(got, map[string]any{"domains": []any{"example.com"}}) {
				t.Fatalf("entries body: %#v", got)
			}
		})
	}
}

func TestMCPCommandStdio(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverIn, clientOut := io.Pipe()
	clientIn, serverOut := io.Pipe()
	defer serverIn.Close()
	defer serverOut.Close()
	h := newHarness(t)
	h.ctx = ctx
	h.app = func(a *App) {
		a.Stdin = serverIn
		a.Stdout = serverOut
	}
	done := make(chan result, 1)
	go func() { done <- h.run("mcp") }()
	client := mcp.NewClient(&mcp.Implementation{Name: "stdio-test", Version: "test"}, nil)
	cs, err := client.Connect(ctx, &mcp.IOTransport{Reader: clientIn, Writer: clientOut}, nil)
	if err != nil {
		clientIn.Close()
		clientOut.Close()
		t.Fatal(err)
	}
	list, err := cs.ListTools(ctx, nil)
	if err != nil || len(list.Tools) != 11 {
		t.Fatalf("stdio tools list: %v, %v", list, err)
	}
	cs.Close()
	select {
	case r := <-done:
		expectCode(t, r, ExitOK)
		if r.stderr != "" {
			t.Fatalf("unexpected stderr: %s", r.stderr)
		}
	case <-ctx.Done():
		t.Fatal("stdio server did not exit after client closed")
	}
}

func TestMCPConcurrentAddsShareOneNewShortlist(t *testing.T) {
	f := newFakeAPI(t)
	collection := `{"id":"` + jobID + `","name":"Research","entryCount":0}`
	var mu sync.Mutex
	created := false
	f.on("GET", "/api/v1/collections", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if created {
			writeRaw(w, 200, page([]string{collection}, ""))
		} else {
			writeRaw(w, 200, page(nil, ""))
		}
	})
	f.on("POST", "/api/v1/collections", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		created = true
		mu.Unlock()
		writeRaw(w, 201, envelope(collection))
	})
	f.reply("POST", "/api/v1/collections/"+jobID+"/entries", 200, envelope(`{"added":1}`))
	c, ctx := mcpTestClient(t, f)
	var wg sync.WaitGroup
	for _, domain := range []string{"example.com", "google.com", "nic.si"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if res := callMCP(t, ctx, c, "shortlist_add", map[string]any{"name": "Research", "domains": []string{domain}}); res.IsError {
				t.Errorf("shortlist_add %s failed", domain)
			}
		}()
	}
	wg.Wait()
	if n := len(f.requests("POST", "/api/v1/collections")); n != 1 {
		t.Fatalf("concurrent adds created %d shortlists, want 1", n)
	}
}
