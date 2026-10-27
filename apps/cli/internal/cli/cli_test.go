package cli

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestJSONEnvelopePassthroughVerbatim(t *testing.T) {
	f := newFakeAPI(t)
	// Odd spacing and an unknown field must survive untouched.
	body := `{"contractVersion": "1.0.0",  "data": ` + jobJSON(jobSpec{state: "running", total: 2}) + `, "x-extra": true}`
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, body)
	r := newHarness(t).api(f, "jobs", "show", jobID)
	expectCode(t, r, ExitOK)
	if r.stdout != body+"\n" {
		t.Fatalf("stdout is not the verbatim envelope:\n%s", r.stdout)
	}
	if r.stderr != "" {
		t.Fatalf("stderr should be empty, got %q", r.stderr)
	}
	if got := f.requests("GET", "/api/v1/jobs/"+jobID)[0].header.Get("Authorization"); got != "Bearer "+testToken {
		t.Fatalf("bearer token not sent: %q", got)
	}
	if got := f.requests("GET", "/api/v1/health")[0].header.Get("Authorization"); got != "" {
		t.Fatalf("health must not carry the token, got %q", got)
	}
}

func TestTableOutput(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/jobs", 200, page([]string{
		jobJSON(jobSpec{state: "running", total: 5, finished: 3, unresolv: 1}),
		jobJSON(jobSpec{id: otherJobID, typ: "quote", state: "completed", total: 2, finished: 2}),
	}, ""))
	r := newHarness(t).api(f, "jobs", "list", "-o", "table")
	expectCode(t, r, ExitOK)
	lines := strings.Split(strings.TrimRight(r.stdout, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("want header + 2 rows, got:\n%s", r.stdout)
	}
	for _, h := range []string{"ID", "TYPE", "STATE", "FINISHED", "UNRESOLVED"} {
		if !strings.Contains(lines[0], h) {
			t.Fatalf("header missing %s: %q", h, lines[0])
		}
	}
	if !strings.Contains(lines[1], jobID) || !strings.Contains(lines[1], "3/5") || !strings.Contains(lines[2], "quote") {
		t.Fatalf("rows wrong:\n%s", r.stdout)
	}
	// Columns are aligned: every row starts the TYPE column at the same offset.
	if strings.Index(lines[1], "registry_scan") != strings.Index(lines[0], "TYPE") {
		t.Fatalf("columns not aligned:\n%s", r.stdout)
	}
}

func TestNDJSONOutput(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, page([]string{
		itemJSON("a.com", "registered", true), itemJSON("bb.com", "no_record", true),
	}, ""))
	r := newHarness(t).api(f, "jobs", "results", jobID, "-o", "ndjson")
	expectCode(t, r, ExitOK)
	lines := strings.Split(strings.TrimRight(r.stdout, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("want one line per item:\n%s", r.stdout)
	}
	for _, l := range lines {
		m := decodeJSON(t, l)
		if m["jobId"] != jobID {
			t.Fatalf("line is not an item: %s", l)
		}
		// Each row names the contract of the envelope it came from (G02).
		if m["contractVersion"] != "1.0.0" || !strings.HasPrefix(l, `{"contractVersion":"1.0.0","id":`) {
			t.Fatalf("row does not lead with contractVersion: %s", l)
		}
	}

	// A single object and an object that already names its version.
	f.reply("GET", "/api/v1/presets", 200, `{"contractVersion":"9.8.7","data":[{"id":"popular","name":"Popular","extensions":["com"],"builtIn":true,"createdAt":null},{"contractVersion":"1.2.3","id":"x"},{}],"nextCursor":null,"total":3}`)
	r = newHarness(t).api(f, "presets", "list", "-o", "ndjson")
	expectCode(t, r, ExitOK)
	want := `{"contractVersion":"9.8.7","id":"popular","name":"Popular","extensions":["com"],"builtIn":true,"createdAt":null}` + "\n" +
		`{"contractVersion":"1.2.3","id":"x"}` + "\n" +
		`{"contractVersion":"9.8.7"}` + "\n"
	if r.stdout != want {
		t.Fatalf("rows not stamped as expected:\n%s", r.stdout)
	}

	// Nested lists render one row per line (input preview rows).
	f.reply("POST", "/api/v1/inputs/preview", 200, envelope(`{"rows":[{"row":1,"original":"Acme","status":"valid","domain":null,"reasons":[],"suggestion":null,"duplicateOf":null,"expandedFrom":null},{"row":2,"original":"x..y","status":"invalid","domain":null,"reasons":[{"code":"invalid_characters","message":"bad"}],"suggestion":null,"duplicateOf":null,"expandedFrom":null}],"domains":["acme.com"],"extensions":["com"],"counts":{"inputRows":2,"valid":1,"duplicate":0,"invalid":1,"ambiguous":0,"uniqueDomains":1,"totalChecks":1}}`))
	r = newHarness(t).api(f, "input", "preview", "Acme", "x..y", "--tlds", ".COM", "-o", "ndjson")
	expectCode(t, r, ExitOK)
	if n := strings.Count(r.stdout, "\n"); n != 2 {
		t.Fatalf("want 2 preview rows, got:\n%s", r.stdout)
	}
	for _, l := range strings.Split(strings.TrimRight(r.stdout, "\n"), "\n") {
		if decodeJSON(t, l)["contractVersion"] != "1.0.0" {
			t.Fatalf("preview row lacks contractVersion: %s", l)
		}
	}
	sent := decodeJSON(t, string(f.requests("POST", "/api/v1/inputs/preview")[0].body))
	if exts := sent["extensions"].([]any); len(exts) != 1 || exts[0] != "com" {
		t.Fatalf("extensions not normalized: %v", sent["extensions"])
	}
}

func TestScanSubmissionReturnsJobAndExitZero(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/jobs", 201, envelope(jobJSON(jobSpec{state: "queued", total: 2})))
	h := newHarness(t)
	h.stdin = "acme\nbeta.io\n"
	r := h.api(f, "scan", "-", "--tlds", "com,io", "--label", "launch")
	expectCode(t, r, ExitOK)
	m := decodeJSON(t, r.stdout)
	if m["contractVersion"] != "1.0.0" || m["data"].(map[string]any)["id"] != jobID {
		t.Fatalf("stdout should be the job envelope: %s", r.stdout)
	}
	req := f.requests("POST", "/api/v1/jobs")[0]
	if !strings.HasPrefix(req.header.Get("Idempotency-Key"), "cli-") {
		t.Fatalf("submission must carry an Idempotency-Key, got %q", req.header.Get("Idempotency-Key"))
	}
	body := decodeJSON(t, string(req.body))
	input := body["input"].(map[string]any)
	if body["type"] != "registry_scan" || body["label"] != "launch" || input["text"] != "acme\nbeta.io\n" {
		t.Fatalf("scan body wrong: %s", req.body)
	}
	if exts := input["extensions"].([]any); len(exts) != 2 || exts[1] != "io" {
		t.Fatalf("extensions wrong: %v", exts)
	}

	// An explicit key is passed through.
	r = newHarness(t).api(f, "scan", "acme", "--idempotency-key", "my-key")
	expectCode(t, r, ExitOK)
	if got := f.requests("POST", "/api/v1/jobs")[1].header.Get("Idempotency-Key"); got != "my-key" {
		t.Fatalf("explicit key not used: %q", got)
	}
}

func TestIdempotentSubmissionRetriesWithSameKey(t *testing.T) {
	f := newFakeAPI(t)
	var calls atomic.Int32
	f.on("POST", "/api/v1/quotes", func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			// Drop the connection before answering.
			conn, _, _ := w.(http.Hijacker).Hijack()
			conn.Close()
			return
		}
		writeRaw(w, 201, envelope(jobJSON(jobSpec{typ: "quote", state: "queued", total: 1})))
	})
	r := newHarness(t).api(f, "quote", "acme.com", "--providers", "porkbun")
	expectCode(t, r, ExitOK)
	reqs := f.requests("POST", "/api/v1/quotes")
	if len(reqs) != 2 {
		t.Fatalf("want a retry, got %d requests", len(reqs))
	}
	if k := reqs[0].header.Get("Idempotency-Key"); k == "" || k != reqs[1].header.Get("Idempotency-Key") {
		t.Fatal("retry must reuse the Idempotency-Key")
	}
	body := decodeJSON(t, string(reqs[0].body))
	if body["providerIds"].([]any)[0] != "porkbun" || body["domains"].([]any)[0] != "acme.com" {
		t.Fatalf("quote body wrong: %s", reqs[0].body)
	}
}

func TestScanWaitStreamsThenPrintsResultsExit3(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/jobs", 201, envelope(jobJSON(jobSpec{state: "queued", total: 2})))
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{state: "running", total: 2})))
	f.on("GET", "/api/v1/events", sseHandler(
		sseEvent("1", "job.progress", jobID, `{"jobId":"`+jobID+`","counters":{"total":2,"pending":1,"running":0,"finished":1,"interrupted":0,"resolved":1,"unresolved":0,"outcomes":{}}}`),
		"id: 2\nevent: heartbeat\ndata: {}\n\n",
		sseEvent("3", "job.updated", jobID, jobJSON(jobSpec{state: "completed_with_errors", total: 2, finished: 2, unresolv: 1, seq: 3})),
	))
	f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, page([]string{
		itemJSON("acme.com", "no_record", true), itemJSON("acme.io", "rate_limited", false),
	}, ""))
	r := newHarness(t).api(f, "scan", "acme", "--tlds", "com,io", "--wait")
	expectCode(t, r, ExitUnresolved)
	m := decodeJSON(t, r.stdout)
	if data := m["data"].([]any); len(data) != 2 || m["nextCursor"] != nil {
		t.Fatalf("stdout should hold all results only: %s", r.stdout)
	}
	if !strings.Contains(r.stderr, "Submitted job "+jobID) || !strings.Contains(r.stderr, "1 unresolved item") {
		t.Fatalf("progress and the exit note belong on stderr: %q", r.stderr)
	}
	ev := f.requests("GET", "/api/v1/events")[0]
	if ev.query.Get("jobId") != jobID || ev.header.Get("Accept") != "text/event-stream" {
		t.Fatalf("event stream request wrong: %v %v", ev.query, ev.header)
	}

	// --quiet keeps stderr empty while stdout still carries results.
	r = newHarness(t).api(f, "scan", "acme", "--wait", "--quiet")
	expectCode(t, r, ExitUnresolved)
	if r.stderr != "" || !strings.Contains(r.stdout, "acme.io") {
		t.Fatalf("quiet run: stdout %q stderr %q", r.stdout, r.stderr)
	}
}

func TestWaitFallsBackToPolling(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/rechecks", 201, envelope(jobJSON(jobSpec{state: "queued", total: 1})))
	var polls atomic.Int32
	f.on("GET", "/api/v1/jobs/"+jobID, func(w http.ResponseWriter, r *http.Request) {
		state := "running"
		if polls.Add(1) >= 3 {
			state = "completed"
		}
		writeRaw(w, 200, envelope(jobJSON(jobSpec{state: state, total: 1, finished: 1})))
	})
	// No events route: the stream answers 404, so the CLI polls.
	f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, page([]string{itemJSON("acme.com", "registered", true)}, ""))
	r := newHarness(t).api(f, "recheck", "ACME.com.", "--wait")
	expectCode(t, r, ExitOK)
	if polls.Load() < 3 || !strings.Contains(r.stderr, "polling") {
		t.Fatalf("expected polling fallback, polls=%d stderr=%q", polls.Load(), r.stderr)
	}
	if body := decodeJSON(t, string(f.requests("POST", "/api/v1/rechecks")[0].body)); body["domains"].([]any)[0] != "acme.com" {
		t.Fatalf("domain not normalized: %v", body)
	}
}

func TestQuoteWaitCredentialRequiredBeatsUnresolved(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/quotes", 201, envelope(jobJSON(jobSpec{typ: "quote", state: "queued", total: 3})))
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{
		typ: "quote", state: "completed_with_errors", total: 3, finished: 3, unresolv: 2,
		outcomes: `{"quoted":1,"credential_required":2}`,
	})))
	f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, page([]string{itemJSON("acme.com", "credential_required", false)}, ""))
	r := newHarness(t).api(f, "quote", "acme.com", "--providers", "porkbun,namecheap", "--wait")
	expectCode(t, r, ExitAccess)
	if !strings.Contains(r.stdout, "credential_required") || !strings.Contains(r.stderr, "credential_required") {
		t.Fatalf("results must still print: stdout %q stderr %q", r.stdout, r.stderr)
	}
}

func TestInterruptedWaitPrintsJobIDAndExits130(t *testing.T) {
	f := newFakeAPI(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.reply("POST", "/api/v1/jobs", 201, envelope(jobJSON(jobSpec{state: "queued", total: 1})))
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{state: "running", total: 1})))
	f.on("GET", "/api/v1/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		go func() { time.Sleep(50 * time.Millisecond); cancel() }() // Ctrl-C
		<-r.Context().Done()
	})
	h := newHarness(t)
	h.ctx = ctx
	r := h.api(f, "scan", "acme.com", "--wait")
	expectCode(t, r, ExitInterrupted)
	if r.stdout != "" || !strings.Contains(r.stderr, jobID) || !strings.Contains(r.stderr, "keeps running") {
		t.Fatalf("stdout %q stderr %q", r.stdout, r.stderr)
	}
	if len(f.requests("POST", "/api/v1/jobs/"+jobID+"/cancel")) != 0 {
		t.Fatal("an interrupt must not cancel the job")
	}
}

func TestJobsWatchPrintsEventsUntilTerminal(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{state: "running", total: 1})))
	f.on("GET", "/api/v1/events", sseHandler(
		sseEvent("7", "job.progress", jobID, `{"jobId":"`+jobID+`","counters":{"total":1,"pending":0,"running":1,"finished":0,"interrupted":0,"resolved":0,"unresolved":0,"outcomes":{}}}`),
		"id: 8\nevent: heartbeat\ndata: {}\n\n",
		sseEvent("9", "job.updated", otherJobID, jobJSON(jobSpec{id: otherJobID, state: "completed"})),
		sseEvent("10", "job.updated", jobID, jobJSON(jobSpec{state: "completed", total: 1, finished: 1})),
	))
	r := newHarness(t).api(f, "jobs", "watch", jobID, "-o", "ndjson")
	expectCode(t, r, ExitOK)
	lines := strings.Split(strings.TrimRight(r.stdout, "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("want the 2 events of this job (no heartbeat, no other job):\n%s", r.stdout)
	}
	if e := decodeJSON(t, lines[1]); e["eventId"] != "10" || e["contractVersion"] != "1.0.0" {
		t.Fatalf("last line should be the terminal DomainEvent: %s", lines[1])
	}
}

func TestErrorResponsesAndExitCodes(t *testing.T) {
	invalid := `{"contractVersion":"1.0.0","error":{"code":"invalid_request","message":"Invalid input","requestId":"req-9","domain":"bad..com","source":null,"retryable":false,"retryAt":null,"details":[{"path":"domains.0","message":"not a domain"}]}}`
	cases := []struct {
		name   string
		status int
		body   string
		want   int
	}{
		{"400 invalid", 400, invalid, ExitUsage},
		{"401 local auth", 401, errJSON("unauthorized", "bad token"), ExitSetup},
		{"409 credential_required", 409, errJSON("credential_required", "Porkbun needs an API key"), ExitAccess},
		{"409 conflict", 409, errJSON("conflict", "job already finished"), ExitFailure},
		{"409 idempotency reuse", 409, errJSON("idempotency_conflict", "key reused with another body"), ExitUsage},
		{"404 not found", 404, errJSON("not_found", "no such job"), ExitFailure},
		{"503 unavailable", 503, errJSON("unavailable", "stopping"), ExitFailure},
		{"500 without contract body", 500, "upstream exploded", ExitFailure},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeAPI(t)
			f.reply("POST", "/api/v1/quotes", tc.status, tc.body)
			r := newHarness(t).api(f, "quote", "acme.com", "--providers", "porkbun")
			expectCode(t, r, tc.want)
			if r.stdout != "" {
				t.Fatalf("errors must not touch stdout: %q", r.stdout)
			}
			if strings.HasPrefix(tc.body, "{") && r.stderr != tc.body+"\n" {
				t.Fatalf("stderr should be the ErrorResponse verbatim:\n%s", r.stderr)
			}
			if !strings.HasPrefix(tc.body, "{") {
				e := decodeJSON(t, r.stderr)["error"].(map[string]any)
				if e["code"] != "internal" || !strings.Contains(e["message"].(string), "HTTP 500") {
					t.Fatalf("synthesized error wrong: %s", r.stderr)
				}
			}
		})
	}

	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/quotes", 400, invalid)
	r := newHarness(t).api(f, "quote", "acme.com", "--providers", "porkbun", "-o", "table")
	expectCode(t, r, ExitUsage)
	for _, want := range []string{"error: Invalid input (invalid_request)", "domain bad..com", "domains.0: not a domain", "req-9"} {
		if !strings.Contains(r.stderr, want) {
			t.Fatalf("table-mode error missing %q:\n%s", want, r.stderr)
		}
	}
}

func TestWrongTokenIsSetupFailure(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/jobs", 200, page(nil, ""))
	h := newHarness(t)
	h.env[EnvAPIToken] = "stale"
	r := h.api(f, "jobs", "list")
	expectCode(t, r, ExitSetup)
	if decodeJSON(t, r.stderr)["error"].(map[string]any)["code"] != "unauthorized" {
		t.Fatalf("stderr: %s", r.stderr)
	}
}

func TestBackendSetupFailures(t *testing.T) {
	closed := newFakeAPI(t)
	closedURL := closed.srv.URL
	closed.srv.Close()
	r := newHarness(t).run("--backend-url", closedURL, "jobs", "list")
	expectCode(t, r, ExitSetup)
	if e := decodeJSON(t, r.stderr)["error"].(map[string]any); e["code"] != "unavailable" || e["requestId"] != "local" {
		t.Fatalf("local errors use the ErrorResponse shape: %s", r.stderr)
	}

	f := newFakeAPI(t)
	f.protocol = 2
	r = newHarness(t).api(f, "jobs", "list")
	expectCode(t, r, ExitSetup)
	if !strings.Contains(r.stderr, "protocol") {
		t.Fatalf("protocol mismatch must be explained: %s", r.stderr)
	}

	f = newFakeAPI(t)
	h := newHarness(t)
	delete(h.env, EnvAPIToken)
	r = h.api(f, "jobs", "list")
	expectCode(t, r, ExitSetup)
	if !strings.Contains(r.stderr, EnvAPIToken) {
		t.Fatalf("missing token should name %s: %s", EnvAPIToken, r.stderr)
	}
}

func writeRuntime(t *testing.T, dataDir, url, instance string) {
	t.Helper()
	run := filepath.Join(dataDir, "run")
	if err := os.MkdirAll(run, 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]any{"url": url, "pid": os.Getpid(), "instanceId": instance, "protocolVersion": 1, "contractVersion": "1.0.0", "version": "1.0.0", "startedAt": "2026-10-05T10:00:00.000Z", "dataDir": dataDir})
	os.WriteFile(filepath.Join(run, "backend.json"), b, 0o600)
	os.WriteFile(filepath.Join(run, "api-token"), []byte(testToken+"\n"), 0o600)
}

func TestRuntimeDiscoveryAndIdentityMismatch(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/jobs", 200, page(nil, ""))
	dataDir := t.TempDir()
	writeRuntime(t, dataDir, f.srv.URL, f.instance)
	h := newHarness(t)
	delete(h.env, EnvAPIToken) // discovery reads the token file
	r := h.run("--data-dir", dataDir, "jobs", "list")
	expectCode(t, r, ExitOK)
	if len(f.requests("GET", "/api/v1/jobs")) != 1 {
		t.Fatal("discovered backend was not used")
	}

	// Same address, different instance: refuse to reuse and never start another.
	other := t.TempDir()
	writeRuntime(t, other, f.srv.URL, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	r = h.run("--data-dir", other, "jobs", "list")
	expectCode(t, r, ExitSetup)
	if !strings.Contains(r.stderr, "identity mismatch") || strings.Contains(r.stderr, "Starting") {
		t.Fatalf("stderr: %s", r.stderr)
	}
	if len(f.requests("GET", "/api/v1/jobs")) != 1 {
		t.Fatal("a mismatched backend must not receive API calls")
	}

	// DOMAIN_SCOUT_DATA_DIR is honoured when no flag is given.
	h.env["DOMAIN_SCOUT_DATA_DIR"] = dataDir
	expectCode(t, h.run("jobs", "list"), ExitOK)
}

func TestNotRunningWithoutAssetsIsSetupFailure(t *testing.T) {
	h := newHarness(t)
	delete(h.env, EnvAPIToken)
	r := h.run("jobs", "list")
	expectCode(t, r, ExitSetup)
	if !strings.Contains(r.stderr, "backend assets not found") {
		t.Fatalf("stderr: %s", r.stderr)
	}
	r = h.run("service", "status")
	expectCode(t, r, ExitSetup)
	if !strings.Contains(r.stderr, "not running") {
		t.Fatalf("stderr: %s", r.stderr)
	}
	r = h.run("service", "stop")
	expectCode(t, r, ExitOK)
	if r.stdout != "" {
		t.Fatalf("stop with nothing running prints no data: %q", r.stdout)
	}
}

func TestResultsAllPagesAndFilterParams(t *testing.T) {
	f := newFakeAPI(t)
	f.on("GET", "/api/v1/jobs/"+jobID+"/results", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cursor") == "c2" {
			writeRaw(w, 200, page([]string{itemJSON("c.com", "no_record", true)}, ""))
			return
		}
		writeRaw(w, 200, page([]string{itemJSON("a.com", "no_record", true), itemJSON("bb.com", "inconclusive", false)}, "c2"))
	})
	r := newHarness(t).api(f, "jobs", "results", jobID, "--all",
		"--outcomes", "no_record,inconclusive", "--resolved", "false", "--sort", "domain", "--order", "desc",
		"--suffixes", ".COM", "--max-price", "12.50", "--price-currency", "USD", "--max-length", "8")
	expectCode(t, r, ExitOK)
	var env pageEnvelope
	if err := json.Unmarshal([]byte(r.stdout), &env); err != nil {
		t.Fatal(err)
	}
	if len(env.Data) != 3 || env.NextCursor != nil || env.Total == nil || *env.Total != 3 || env.ContractVersion != "1.0.0" {
		t.Fatalf("combined envelope wrong: %s", r.stdout)
	}
	reqs := f.requests("GET", "/api/v1/jobs/"+jobID+"/results")
	q := reqs[0].query
	want := map[string]string{"outcomes": "no_record,inconclusive", "resolved": "false", "sort": "domain", "order": "desc", "suffixes": "com", "maxPrice": "12.50", "priceCurrency": "USD", "maxLength": "8"}
	for k, v := range want {
		if q.Get(k) != v {
			t.Fatalf("query %s = %q, want %q (all: %v)", k, q.Get(k), v, q)
		}
	}
	if len(reqs) != 2 || reqs[1].query.Get("cursor") != "c2" || reqs[1].query.Get("outcomes") != "no_record,inconclusive" {
		t.Fatalf("second page must keep filters and use the cursor: %v", reqs[1].query)
	}
}

func TestUsageErrorsExit2WithoutRequests(t *testing.T) {
	f := newFakeAPI(t)
	cases := [][]string{
		{"scan"},                       // no input
		{"jobs", "show", "not-a-uuid"}, // bad id
		{"jobs", "show"},               // missing arg
		{"jobs", "list", "--bogus"},    // unknown flag
		{"jobs", "list", "-o", "yaml"}, // bad output mode
		{"jobs", "results", jobID, "--resolved", "maybe"},
		{"jobs", "results", jobID, "--sort", "price-ish"},
		{"jobs", "results", jobID, "--states", "done"},
		{"quote", "acme.com"}, // --providers required
		{"diagnose", "acme.com", "--checks", "ping"},
		{"name-check", "acme", "--services", "myspace"},
		{"compare", "acme.com", "--horizon", "11"},
		{"generate", "acme", "--wait"},
		{"data", "delete", "--categories", "jobs"}, // no --yes
		{"data", "delete", "--categories", "everything", "--yes"},
		{"notices", "read"},
		{"jobs"},
		{"nonexistent"},
	}
	for _, args := range cases {
		r := newHarness(t).api(f, args...)
		if r.code != ExitUsage {
			t.Fatalf("%v: exit %d, want 2\nstderr: %s", args, r.code, r.stderr)
		}
		if r.stdout != "" {
			t.Fatalf("%v: usage errors must not print to stdout", args)
		}
		if e := decodeJSON(t, r.stderr)["error"].(map[string]any); e["code"] != "invalid_request" {
			t.Fatalf("%v: stderr %s", args, r.stderr)
		}
	}
	for _, rq := range f.reqs {
		if rq.path != "/api/v1/health" {
			t.Fatalf("usage errors must not call the API, saw %s %s", rq.method, rq.path)
		}
	}
	// --no-input is accepted everywhere.
	expectCode(t, newHarness(t).api(f, "--no-input", "version"), ExitOK)
}

func TestDataDeleteRequiresYes(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/data/delete", 200, envelope(`{"deleted":[{"category":"jobs","count":3}]}`))
	r := newHarness(t).api(f, "data", "delete", "--categories", "jobs")
	expectCode(t, r, ExitUsage)
	if !strings.Contains(r.stderr, "--yes") || f.count() != 0 {
		t.Fatalf("must refuse without contacting the backend: %s (requests %d)", r.stderr, f.count())
	}
	r = newHarness(t).api(f, "data", "delete", "--categories", "jobs,price_history", "--before", "2026-01-01T00:00:00Z", "--yes", "-o", "table")
	expectCode(t, r, ExitOK)
	body := decodeJSON(t, string(f.requests("POST", "/api/v1/data/delete")[0].body))
	if len(body["categories"].([]any)) != 2 || body["before"] != "2026-01-01T00:00:00Z" {
		t.Fatalf("delete body wrong: %v", body)
	}
	if !strings.Contains(r.stdout, "jobs") || !strings.Contains(r.stdout, "3") {
		t.Fatalf("table: %s", r.stdout)
	}
}

func exportArtifact(scope string) string {
	return envelope(`{"id":"` + exportID + `","format":"txt","scope":` + scope + `,"fields":["domain"],"itemCount":2,"fileName":"export.txt","sizeBytes":12,"createdAt":"2026-10-05T10:00:00.000Z","downloadPath":"/api/v1/exports/` + exportID + `/download","warnings":["1 name has unresolved registry evidence"]}`)
}

func TestExportScopeValidation(t *testing.T) {
	f := newFakeAPI(t)
	bad := []struct {
		args []string
		msg  string
	}{
		{[]string{}, "--scope is required"},
		{[]string{"--scope", "everything"}, "invalid --scope"},
		{[]string{"--scope", "all", "--job", jobID}, "--job does not apply"},
		{[]string{"--scope", "job"}, "requires --job"},
		{[]string{"--scope", "job", "--job", "nope"}, "not a valid id"},
		{[]string{"--scope", "filter", "--outcomes", "no_record"}, "requires --job"},
		{[]string{"--scope", "job", "--job", jobID, "--outcomes", "no_record"}, "filter flags does not apply"},
		{[]string{"--scope", "selection"}, "requires --items"},
		{[]string{"--scope", "selection", "--items", "x"}, "not a valid id"},
		{[]string{"--scope", "collection"}, "requires --shortlist"},
		{[]string{"--scope", "domains"}, "requires --domains"},
		{[]string{"--scope", "collection", "--shortlist", jobID, "--domains", "a.com"}, "--domains does not apply"},
		{[]string{"--scope", "all", "--format", "xml"}, "--format"},
		{[]string{"--scope", "all", "--format", "csv", "--candidates-only"}, "only to --format txt"},
		{[]string{"--scope", "all", "--fields", "domain,colour"}, "unknown export field"},
	}
	for _, tc := range bad {
		r := newHarness(t).api(f, append([]string{"export"}, tc.args...)...)
		if r.code != ExitUsage || !strings.Contains(r.stderr, tc.msg) {
			t.Fatalf("%v: exit %d stderr %s (want %q)", tc.args, r.code, r.stderr, tc.msg)
		}
	}
	if len(f.requests("POST", "/api/v1/exports")) != 0 {
		t.Fatal("invalid scopes must not reach the API")
	}

	good := []struct {
		args []string
		want map[string]any
	}{
		{[]string{"--scope", "all"}, map[string]any{"kind": "all"}},
		{[]string{"--scope", "job", "--job", jobID}, map[string]any{"kind": "job", "jobId": jobID}},
		{[]string{"--scope", "collection", "--shortlist", otherJobID}, map[string]any{"kind": "collection", "collectionId": otherJobID}},
		{[]string{"--scope", "domains", "--domains", "A.com,b.com"}, map[string]any{"kind": "domains"}},
		{[]string{"--scope", "selection", "--items", jobID + "," + otherJobID}, map[string]any{"kind": "selection"}},
		{[]string{"--scope", "filter", "--job", jobID, "--outcomes", "no_record", "--resolved", "true"}, map[string]any{"kind": "filter", "jobId": jobID}},
	}
	f.reply("POST", "/api/v1/exports", 201, exportArtifact(`{"kind":"all"}`))
	f.on("GET", "/api/v1/exports/"+exportID+"/download", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("a.com\nb.com\n"))
	})
	for i, tc := range good {
		r := newHarness(t).api(f, append([]string{"export", "--format", "txt"}, tc.args...)...)
		expectCode(t, r, ExitOK)
		body := decodeJSON(t, string(f.requests("POST", "/api/v1/exports")[i].body))
		scope := body["scope"].(map[string]any)
		for k, v := range tc.want {
			if scope[k] != v {
				t.Fatalf("%v: scope %v", tc.args, scope)
			}
		}
		switch scope["kind"] {
		case "domains":
			if d := scope["domains"].([]any); len(d) != 2 || d[0] != "a.com" {
				t.Fatalf("domains scope %v", scope)
			}
		case "selection":
			if len(scope["itemIds"].([]any)) != 2 {
				t.Fatalf("selection scope %v", scope)
			}
		case "filter":
			fl := scope["filter"].(map[string]any)
			if fl["resolved"] != true || fl["outcomes"].([]any)[0] != "no_record" {
				t.Fatalf("filter scope %v", scope)
			}
		}
	}
}

func TestExportDownloadsArtifact(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/exports", 201, exportArtifact(`{"kind":"job","jobId":"`+jobID+`"}`))
	f.on("GET", "/api/v1/exports/"+exportID+"/download", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("a.com\nb.com\n"))
	})
	// Default: the file is the requested data on stdout; metadata and warnings go to stderr.
	r := newHarness(t).api(f, "export", "--scope", "job", "--job", jobID, "--format", "txt", "--candidates-only")
	expectCode(t, r, ExitOK)
	if r.stdout != "a.com\nb.com\n" || !strings.Contains(r.stderr, "unresolved registry evidence") {
		t.Fatalf("stdout %q stderr %q", r.stdout, r.stderr)
	}
	// --out writes the file and prints the export envelope.
	out := filepath.Join(t.TempDir(), "names.txt")
	r = newHarness(t).api(f, "export", "--scope", "job", "--job", jobID, "--format", "txt", "--out", out)
	expectCode(t, r, ExitOK)
	b, _ := os.ReadFile(out)
	if string(b) != "a.com\nb.com\n" || decodeJSON(t, r.stdout)["data"].(map[string]any)["id"] != exportID {
		t.Fatalf("file %q stdout %q", b, r.stdout)
	}
	entries, _ := os.ReadDir(filepath.Dir(out))
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

func providerJSON() string {
	return envelope(`{"id":"porkbun","name":"Porkbun","credentialFields":[
		{"key":"apiKey","label":"API key","secret":true,"required":true,"help":null,"envVar":"PORKBUN_API_KEY"},
		{"key":"secretApiKey","label":"Secret API key","secret":true,"required":true,"help":null,"envVar":"PORKBUN_SECRET_API_KEY"}],
		"credentials":{"configured":true,"storage":"file","storageLocation":"/tmp/creds","fields":[{"key":"apiKey","set":true}],"lastTestedAt":null,"lastTestResult":null,"lastTestMessage":null}}`)
}

func TestProvidersConfigureNeverEchoesSecrets(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/providers/porkbun", 200, providerJSON())
	f.reply("PUT", "/api/v1/providers/porkbun/credentials", 200, providerJSON())
	f.reply("POST", "/api/v1/providers/porkbun/credentials/test", 200, envelope(`{"result":"failed","testedAt":"2026-10-05T10:00:00.000Z","operation":"ping","message":"invalid key"}`))

	h := newHarness(t)
	h.env["PORKBUN_API_KEY"] = "pk_Zq9_env"
	h.stdin = "secretApiKey=sk_Zq9_stdin\n"
	r := h.api(f, "providers", "configure", "PorkBun", "--from-env", "--stdin", "--storage", "file")
	expectCode(t, r, ExitOK)
	put := decodeJSON(t, string(f.requests("PUT", "/api/v1/providers/porkbun/credentials")[0].body))
	values := put["values"].(map[string]any)
	if values["apiKey"] != "pk_Zq9_env" || values["secretApiKey"] != "sk_Zq9_stdin" || put["storage"] != "file" {
		t.Fatalf("credential body wrong: %v", put)
	}
	for _, s := range []string{r.stdout, r.stderr} {
		if strings.Contains(s, "Zq9") {
			t.Fatalf("secret echoed: %s", s)
		}
	}

	// Flags win over env; --test failure maps to exit 4.
	h = newHarness(t)
	h.env["PORKBUN_API_KEY"] = "pk_Zq9_env"
	r = h.api(f, "providers", "configure", "porkbun", "--from-env", "--value", "secretApiKey=sk_Zq9_flag", "--test")
	expectCode(t, r, ExitAccess)
	if strings.Contains(r.stdout+r.stderr, "Zq9") || !strings.Contains(r.stderr, "invalid key") {
		t.Fatalf("stdout %q stderr %q", r.stdout, r.stderr)
	}
	puts := f.requests("PUT", "/api/v1/providers/porkbun/credentials")
	if decodeJSON(t, string(puts[1].body))["storage"] != "session" {
		t.Fatal("storage defaults to session")
	}

	// Unknown and missing fields are usage errors that name keys, never values.
	r = newHarness(t).api(f, "providers", "configure", "porkbun", "--value", "apiKey=Zq9one", "--value", "token=Zq9two")
	expectCode(t, r, ExitUsage)
	if !strings.Contains(r.stderr, "token") || strings.Contains(r.stderr, "Zq9") {
		t.Fatalf("stderr %s", r.stderr)
	}
	r = newHarness(t).api(f, "providers", "configure", "porkbun", "--value", "apiKey=Zq9one")
	expectCode(t, r, ExitUsage)
	if !strings.Contains(r.stderr, "secretApiKey (env PORKBUN_SECRET_API_KEY)") || strings.Contains(r.stderr, "Zq9") {
		t.Fatalf("stderr %s", r.stderr)
	}

	// 409 credential_required from any operation is exit 4.
	f.reply("POST", "/api/v1/provider-checks", 409, errJSON("credential_required", "Namecheap needs credentials"))
	r = newHarness(t).api(f, "provider-check", "acme.com", "--providers", "namecheap")
	expectCode(t, r, ExitAccess)
}

func TestGenerateNeverScansUnlessAsked(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/generation/preview", 200, envelope(`{"candidates":[
		{"name":"acme","domain":null,"strategy":"roots","rule":"root","valid":true,"issues":[]},
		{"name":"x","domain":null,"strategy":"roots","rule":"root","valid":false,"issues":["too short"]},
		{"name":"ac","domain":"ac.me","strategy":"hacks","rule":"hack","valid":true,"issues":[]}],
		"counts":{"generated":3,"unique":3,"duplicates":0,"invalid":1,"filtered":0},"extensions":["com","io"],"expandedChecks":5}`))
	f.reply("POST", "/api/v1/jobs", 201, envelope(jobJSON(jobSpec{state: "queued", total: 5})))

	r := newHarness(t).api(f, "generate", "acme", "--strategies", "roots,hacks", "--tlds", "com,io", "--max-length", "10", "-o", "table")
	expectCode(t, r, ExitOK)
	if len(f.requests("POST", "/api/v1/jobs")) != 0 {
		t.Fatal("generate must not submit a scan")
	}
	if !strings.Contains(r.stdout, "expanded checks") || !strings.Contains(r.stdout, "ac.me") {
		t.Fatalf("table: %s", r.stdout)
	}
	gen := decodeJSON(t, string(f.requests("POST", "/api/v1/generation/preview")[0].body))
	if gen["rules"].(map[string]any)["maxLength"] != float64(10) || gen["roots"].([]any)[0] != "acme" {
		t.Fatalf("generation body %v", gen)
	}

	r = newHarness(t).api(f, "generate", "acme", "--scan")
	expectCode(t, r, ExitOK)
	body := decodeJSON(t, string(f.requests("POST", "/api/v1/jobs")[0].body))
	input := body["input"].(map[string]any)
	if d := input["domains"].([]any); len(d) != 2 || d[0] != "acme" || d[1] != "ac.me" {
		t.Fatalf("only valid candidates are submitted: %v", input)
	}
	if body["type"] != "registry_scan" || len(input["extensions"].([]any)) != 2 {
		t.Fatalf("scan body %v", body)
	}
}

func TestSettingsSetBuildsNestedPatch(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("PATCH", "/api/v1/settings", 200, envelope(`{"concurrency":{"global":8}}`))
	r := newHarness(t).api(f, "settings", "set", "concurrency.global=8", "privacy.keepRawDiagnostics=true", "comparison.currency=EUR")
	expectCode(t, r, ExitOK)
	body := decodeJSON(t, string(f.requests("PATCH", "/api/v1/settings")[0].body))
	if body["concurrency"].(map[string]any)["global"] != float64(8) || body["privacy"].(map[string]any)["keepRawDiagnostics"] != true || body["comparison"].(map[string]any)["currency"] != "EUR" {
		t.Fatalf("patch %v", body)
	}
}

func TestNotesSetCanClearShortlistNotes(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("PATCH", "/api/v1/collections/"+jobID, 200, envelope(`{"id":"`+jobID+`"}`))
	f.reply("PATCH", "/api/v1/collections/"+jobID+"/entries/acme.com", 200, envelope(`{"ok":true}`))
	expectCode(t, newHarness(t).api(f, "notes", "set", jobID, "--clear"), ExitOK)
	if got := string(f.requests("PATCH", "/api/v1/collections/"+jobID)[0].body); got != `{"notes":null}` {
		t.Fatalf("clear must send null: %s", got)
	}
	expectCode(t, newHarness(t).api(f, "notes", "set", jobID, "ACME.com", "--text", "short and clear"), ExitOK)
	if got := string(f.requests("PATCH", "/api/v1/collections/"+jobID+"/entries/acme.com")[0].body); !strings.Contains(got, "short and clear") {
		t.Fatalf("entry notes body: %s", got)
	}
	expectCode(t, newHarness(t).api(f, "notes", "set", jobID), ExitUsage)
}

// Lifecycle against a fake `node` (this test binary) using the packaged layout.
func TestServiceLifecycleAutostartAndUI(t *testing.T) {
	if os.Getenv("GOOS") == "windows" {
		t.Skip("POSIX only")
	}
	prefix := t.TempDir()
	for _, p := range []string{"lib/backend/dist/main.js", "lib/web/server.js"} {
		full := filepath.Join(prefix, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, []byte("//\n"), 0o644)
	}
	dataDir := filepath.Join(t.TempDir(), "data")
	port, webPort := freePort(t), freePort(t)
	var opened string
	h := newHarness(t)
	delete(h.env, EnvAPIToken)
	h.env["DOMAIN_SCOUT_NODE"] = os.Args[0]
	h.env["DOMAIN_SCOUT_PORT"] = itoa(port)
	h.app = func(a *App) {
		a.Executable = filepath.Join(prefix, "bin", "domain-scout")
		a.LauncherEnv = []string{"FAKE_NODE=1"}
		a.OpenURL = func(u string) error { opened = u; return nil }
	}
	t.Cleanup(func() {
		killFromFile(filepath.Join(dataDir, "run", "web.json"))
		killFromFile(filepath.Join(dataDir, "run", "backend.json"))
	})

	expectCode(t, h.run("--data-dir", dataDir, "service", "status"), ExitSetup)

	// Any API command auto-starts the installed backend.
	r := h.run("--data-dir", dataDir, "jobs", "list")
	expectCode(t, r, ExitOK)
	if !strings.Contains(r.stderr, "Starting the Domain Scout backend") || !strings.Contains(r.stdout, `"data":[]`) {
		t.Fatalf("autostart: stdout %q stderr %q", r.stdout, r.stderr)
	}
	status := h.run("--data-dir", dataDir, "service", "status")
	expectCode(t, status, ExitOK)
	start := h.run("--data-dir", dataDir, "service", "start")
	expectCode(t, start, ExitOK)
	instance := func(s string) any { return decodeJSON(t, s)["data"].(map[string]any)["instanceId"] }
	if instance(start.stdout) != instance(status.stdout) || !strings.Contains(start.stderr, "already running") {
		t.Fatalf("start should reuse the verified backend: %s / %s", start.stdout, start.stderr)
	}

	r = h.run("--data-dir", dataDir, "ui", "--web-port", itoa(webPort))
	expectCode(t, r, ExitOK)
	if !strings.HasPrefix(opened, "http://127.0.0.1:"+itoa(webPort)+"/auth/bootstrap?code=bootstrap-code-") || r.stdout != "" {
		t.Fatalf("browser link %q stdout %q", opened, r.stdout)
	}
	r = h.run("--data-dir", dataDir, "ui", "--no-open", "--web-port", itoa(webPort))
	expectCode(t, r, ExitOK)
	if !strings.Contains(r.stderr, "/auth/bootstrap?code=") || r.stdout != "" {
		t.Fatalf("--no-open prints the link to stderr only: stdout %q stderr %q", r.stdout, r.stderr)
	}

	r = h.run("--data-dir", dataDir, "service", "stop")
	expectCode(t, r, ExitOK)
	if decodeJSON(t, r.stdout)["data"].(map[string]any)["stopping"] != true {
		t.Fatalf("stop output %s", r.stdout)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "run", "backend.json")); !os.IsNotExist(err) {
		t.Fatal("backend.json should be gone after stop")
	}
	expectCode(t, h.run("--data-dir", dataDir, "service", "status"), ExitSetup)
}

func TestServiceStartSetupErrors(t *testing.T) {
	prefix := t.TempDir()
	full := filepath.Join(prefix, "lib", "backend", "dist", "main.js")
	os.MkdirAll(filepath.Dir(full), 0o755)
	os.WriteFile(full, []byte("//\n"), 0o644)
	h := newHarness(t)
	h.env["DOMAIN_SCOUT_NODE"] = os.Args[0]
	oldNode := []string{"FAKE_NODE=1", "FAKE_NODE_VERSION=v24.21.0"}
	h.app = func(a *App) {
		a.Executable = filepath.Join(prefix, "bin", "domain-scout")
		a.LauncherEnv = oldNode
	}
	r := h.run("--data-dir", t.TempDir(), "service", "start", "--port", itoa(freePort(t)))
	expectCode(t, r, ExitSetup)
	if !strings.Contains(r.stderr, "26.0.0 or newer") {
		t.Fatalf("old node: %s", r.stderr)
	}

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	oldNode[1] = "FAKE_NODE_VERSION=v26.0.0"
	r = h.run("--data-dir", t.TempDir(), "service", "start", "--port", itoa(l.Addr().(*net.TCPAddr).Port))
	expectCode(t, r, ExitSetup)
	if !strings.Contains(r.stderr, "in use") {
		t.Fatalf("port conflict: %s", r.stderr)
	}
}

func killFromFile(path string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var v struct {
		PID int `json:"pid"`
	}
	if json.Unmarshal(b, &v) == nil && v.PID > 0 {
		if p, err := os.FindProcess(v.PID); err == nil {
			p.Kill()
		}
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func itoa(n int) string { return strings.TrimSpace(jsonNumber(n)) }

func jsonNumber(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestScanDashMixesArgsAndStdin(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/jobs", 201, envelope(jobJSON(jobSpec{state: "queued", total: 2})))
	h := newHarness(t)
	h.stdin = "beta.io\n"
	expectCode(t, h.api(f, "scan", "acme.com", "-"), ExitOK)
	input := decodeJSON(t, string(f.requests("POST", "/api/v1/jobs")[0].body))["input"].(map[string]any)
	if input["text"] != "beta.io\n" || input["domains"].([]any)[0] != "acme.com" || len(input["domains"].([]any)) != 1 {
		t.Fatalf("input %v", input)
	}
}

func TestResumeIsNotRetried(t *testing.T) {
	f := newFakeAPI(t)
	f.on("POST", "/api/v1/jobs/"+jobID+"/resume", func(w http.ResponseWriter, r *http.Request) {
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close()
	})
	r := newHarness(t).api(f, "jobs", "resume", jobID)
	expectCode(t, r, ExitSetup)
	if n := len(f.requests("POST", "/api/v1/jobs/"+jobID+"/resume")); n != 1 {
		t.Fatalf("resume has no Idempotency-Key and must not be retried, saw %d requests", n)
	}
}

func TestJobsWatchFinishedJobPrintsState(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{state: "interrupted", total: 4, finished: 1})))
	f.on("GET", "/api/v1/events", sseHandler())
	r := newHarness(t).api(f, "jobs", "watch", jobID)
	expectCode(t, r, ExitUnresolved)
	if decodeJSON(t, r.stdout)["data"].(map[string]any)["state"] != "interrupted" || !strings.Contains(r.stderr, "jobs resume "+jobID) {
		t.Fatalf("stdout %q stderr %q", r.stdout, r.stderr)
	}
}

func TestUIWithCustomPortStartsBackendWithOrigins(t *testing.T) {
	prefix := t.TempDir()
	for _, p := range []string{"lib/backend/dist/main.js", "lib/web/server.js"} {
		full := filepath.Join(prefix, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, []byte("//\n"), 0o644)
	}
	dataDir := filepath.Join(t.TempDir(), "data")
	webPort := freePort(t)
	h := newHarness(t)
	delete(h.env, EnvAPIToken)
	h.env["DOMAIN_SCOUT_NODE"] = os.Args[0]
	h.env["DOMAIN_SCOUT_PORT"] = itoa(freePort(t))
	h.app = func(a *App) {
		a.Executable = filepath.Join(prefix, "bin", "domain-scout")
		a.LauncherEnv = []string{"FAKE_NODE=1"}
	}
	t.Cleanup(func() {
		killFromFile(filepath.Join(dataDir, "run", "web.json"))
		killFromFile(filepath.Join(dataDir, "run", "backend.json"))
	})
	r := h.run("--data-dir", dataDir, "ui", "--no-open", "--web-port", itoa(webPort))
	expectCode(t, r, ExitOK)
	log, _ := os.ReadFile(filepath.Join(dataDir, "logs", "backend.log"))
	for _, o := range []string{"http://127.0.0.1:" + itoa(webPort), "http://localhost:" + itoa(webPort)} {
		if !strings.Contains(string(log), "--web-origin "+o) {
			t.Fatalf("backend not started with origin %s:\n%s", o, log)
		}
	}
	web, _ := os.ReadFile(filepath.Join(dataDir, "run", "web.json"))
	if !strings.Contains(string(web), itoa(webPort)) {
		t.Fatalf("web.json %s", web)
	}
}

func TestStreamRequestErrorsKeepExitCodes(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/events", 400, errJSON("invalid_request", "bad types filter"))
	r := newHarness(t).api(f, "events", "--types", "nope")
	expectCode(t, r, ExitUsage)
	if r.stderr != errJSON("invalid_request", "bad types filter")+"\n" {
		t.Fatalf("stderr should be the ErrorResponse: %s", r.stderr)
	}

	f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{state: "running", total: 1})))
	f.reply("GET", "/api/v1/events", 403, errJSON("forbidden", "origin not allowed"))
	r = newHarness(t).api(f, "jobs", "watch", jobID)
	expectCode(t, r, ExitSetup)
	if len(f.requests("GET", "/api/v1/jobs/"+jobID)) != 0 {
		t.Fatal("an auth failure on the stream must not fall back to polling")
	}
}

func TestServiceStartRejectsBadPort(t *testing.T) {
	for _, p := range []string{"0", "-1", "65536"} {
		r := newHarness(t).run("service", "start", "--port", p)
		expectCode(t, r, ExitUsage)
	}
}

func TestRejectedCredentialsAreAccessExit(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/quotes", 201, envelope(jobJSON(jobSpec{typ: "quote", state: "queued", total: 2})))
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{
		typ: "quote", state: "completed_with_errors", total: 2, finished: 2, unresolv: 2,
		outcomes: `{"credentials_invalid":1,"timeout":1}`,
	})))
	f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, page([]string{itemJSON("acme.com", "credentials_invalid", false)}, ""))
	r := newHarness(t).api(f, "quote", "acme.com", "--providers", "porkbun", "--wait")
	expectCode(t, r, ExitAccess)
	if !strings.Contains(r.stdout, "credentials_invalid") || !strings.Contains(r.stderr, "1 credentials_invalid") {
		t.Fatalf("results must still print: stdout %q stderr %q", r.stdout, r.stderr)
	}
}

// Settings decide horizon, currency, resolver, watch interval and the TXT
// candidate filter; the CLI sends them only when the user asks.
func TestSettingsBackedDefaultsAreSentOnlyWhenGiven(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/comparisons", 200, envelope(`{}`))
	f.reply("POST", "/api/v1/diagnostics", 201, envelope(jobJSON(jobSpec{typ: "diagnostics", state: "queued", total: 1})))
	f.reply("POST", "/api/v1/watches", 201, envelope(`{}`))
	f.reply("POST", "/api/v1/exports", 201, exportArtifact(`{"kind":"all"}`))
	f.on("GET", "/api/v1/exports/"+exportID+"/download", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("a.com\n"))
	})
	run := func(method, path string, args ...string) map[string]any {
		t.Helper()
		expectCode(t, newHarness(t).api(f, args...), ExitOK)
		reqs := f.requests(method, path)
		return decodeJSON(t, string(reqs[len(reqs)-1].body))
	}

	body := run("POST", "/api/v1/comparisons", "compare", "acme.com")
	if _, ok := body["horizonYears"]; ok {
		t.Fatalf("horizon sent without --horizon: %v", body)
	}
	if _, ok := body["currency"]; ok {
		t.Fatalf("currency sent without --currency: %v", body)
	}
	body = run("POST", "/api/v1/comparisons", "compare", "acme.com", "--horizon", "5", "--currency", "EUR")
	if body["horizonYears"] != float64(5) || body["currency"] != "EUR" {
		t.Fatalf("explicit values not sent: %v", body)
	}
	body = run("POST", "/api/v1/comparisons", "compare", "acme.com", "--currency", "original")
	if v, ok := body["currency"]; !ok || v != nil {
		t.Fatalf("--currency original must send null: %v", body)
	}

	body = run("POST", "/api/v1/diagnostics", "diagnose", "acme.com", "--checks", "dns")
	if _, ok := body["resolver"]; ok {
		t.Fatalf("resolver sent without --resolver: %v", body)
	}
	if body = run("POST", "/api/v1/diagnostics", "diagnose", "acme.com", "--checks", "dns", "--resolver", "google"); body["resolver"] != "google" {
		t.Fatalf("explicit resolver not sent: %v", body)
	}

	body = run("POST", "/api/v1/watches", "watches", "create", "acme.com", "--name", "W")
	if _, ok := body["intervalMinutes"]; ok {
		t.Fatalf("interval sent without --interval: %v", body)
	}

	body = run("POST", "/api/v1/exports", "export", "--scope", "all", "--format", "txt")
	if _, ok := body["candidatesOnly"]; ok {
		t.Fatalf("candidatesOnly sent by default: %v", body)
	}
	if body = run("POST", "/api/v1/exports", "export", "--scope", "all", "--format", "txt", "--candidates-only=false"); body["candidatesOnly"] != false {
		t.Fatalf("--candidates-only=false not sent: %v", body)
	}
}

func TestNoticesReadAllForOneWatch(t *testing.T) {
	f := newFakeAPI(t)
	f.reply("POST", "/api/v1/notices/read", 200, envelope(`{"ok":true}`))
	expectCode(t, newHarness(t).api(f, "notices", "read", "--all", "--watch", otherJobID), ExitOK)
	body := decodeJSON(t, string(f.requests("POST", "/api/v1/notices/read")[0].body))
	if body["all"] != true || body["watchId"] != otherJobID {
		t.Fatalf("body %v", body)
	}
	expectCode(t, newHarness(t).api(f, "notices", "read", jobID, "--watch", otherJobID), ExitUsage)
	if len(f.requests("POST", "/api/v1/notices/read")) != 1 {
		t.Fatal("usage errors must not reach the API")
	}
}

// B03: a preset saved anywhere (the web UI included) is listed by its id, and
// scan and input preview send that same id back for the backend to expand.
func TestSavedPresetIDIsReusedByScanAndPreview(t *testing.T) {
	const presetID = "5f0c3d2e-8a41-4c6b-9d7e-2b1f0a9c8e71"
	f := newFakeAPI(t)
	f.reply("GET", "/api/v1/presets", 200, page([]string{
		`{"id":"popular","name":"Popular","extensions":["com","net"],"builtIn":true,"createdAt":null}`,
		`{"id":"` + presetID + `","name":"Saved in the UI","extensions":["si","co.uk"],"builtIn":false,"createdAt":"2026-10-05T12:00:00.000Z"}`,
	}, ""))
	f.reply("POST", "/api/v1/jobs", 201, envelope(jobJSON(jobSpec{state: "queued", total: 2})))
	f.reply("POST", "/api/v1/inputs/preview", 200, envelope(`{"rows":[],"domains":["example.si","example.co.uk"],"extensions":["si","co.uk"],"counts":{"inputRows":1,"valid":1,"duplicate":0,"invalid":0,"ambiguous":0,"uniqueDomains":2,"totalChecks":2}}`))

	r := newHarness(t).api(f, "presets", "list", "-o", "ndjson")
	expectCode(t, r, ExitOK)
	listed := ""
	for _, l := range strings.Split(strings.TrimRight(r.stdout, "\n"), "\n") {
		if m := decodeJSON(t, l); m["builtIn"] == false {
			listed, _ = m["id"].(string)
		}
	}
	if listed != presetID {
		t.Fatalf("saved preset not listed by id:\n%s", r.stdout)
	}

	r = newHarness(t).api(f, "scan", "example", "--preset", listed)
	expectCode(t, r, ExitOK)
	scan := decodeJSON(t, string(f.requests("POST", "/api/v1/jobs")[0].body))
	if input := scan["input"].(map[string]any); input["presetId"] != presetID {
		t.Fatalf("scan did not send the listed preset id: %v", input)
	}

	r = newHarness(t).api(f, "input", "preview", "example", "--preset", listed)
	expectCode(t, r, ExitOK)
	preview := decodeJSON(t, string(f.requests("POST", "/api/v1/inputs/preview")[0].body))
	if preview["presetId"] != presetID {
		t.Fatalf("preview did not send the listed preset id: %v", preview)
	}
}
