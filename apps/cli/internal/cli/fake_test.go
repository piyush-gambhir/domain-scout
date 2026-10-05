package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/piyush-gambhir/domain-scout/cli/internal/fakenode"
)

func TestMain(m *testing.M) {
	fakenode.Main()
	streamIdleTimeout = 2 * time.Second
	os.Exit(m.Run())
}

const (
	testToken  = "test-token"
	jobID      = "11111111-1111-4111-8111-111111111111"
	otherJobID = "22222222-2222-4222-8222-222222222222"
	exportID   = "33333333-3333-4333-8333-333333333333"
)

type recorded struct {
	method, path string
	query        url.Values
	header       http.Header
	body         []byte
}

// fakeAPI mimics the local API: health without auth, bearer auth elsewhere,
// ErrorResponse bodies for failures, and per-test routes.
type fakeAPI struct {
	t        *testing.T
	srv      *httptest.Server
	instance string
	protocol int

	mu     sync.Mutex
	routes map[string]http.HandlerFunc
	reqs   []recorded
}

func newFakeAPI(t *testing.T) *fakeAPI {
	f := &fakeAPI{t: t, instance: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", protocol: 1, routes: map[string]http.HandlerFunc{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.reqs = append(f.reqs, recorded{method: r.Method, path: r.URL.Path, query: r.URL.Query(), header: r.Header.Clone(), body: body})
	h := f.routes[r.Method+" "+r.URL.Path]
	f.mu.Unlock()
	if r.URL.Path == "/api/v1/health" {
		fmt.Fprintf(w, `{"contractVersion":"1.0.0","data":{"status":"ok","instanceId":"%s","protocolVersion":%d,"contractVersion":"1.0.0","version":"1.0.0","startedAt":"2026-10-05T10:00:00.000Z","pid":1,"dataDir":"/tmp/fake"}}`, f.instance, f.protocol)
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		writeRaw(w, 401, errJSON("unauthorized", "missing or invalid API token"))
		return
	}
	if h == nil {
		writeRaw(w, 404, errJSON("not_found", "no route for "+r.Method+" "+r.URL.Path))
		return
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	h(w, r)
}

func (f *fakeAPI) on(method, path string, h http.HandlerFunc) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes[method+" "+path] = h
}

func (f *fakeAPI) reply(method, path string, status int, body string) {
	f.on(method, path, func(w http.ResponseWriter, r *http.Request) { writeRaw(w, status, body) })
}

func (f *fakeAPI) requests(method, path string) []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []recorded
	for _, r := range f.reqs {
		if r.method == method && r.path == path {
			out = append(out, r)
		}
	}
	return out
}

func (f *fakeAPI) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.reqs)
}

func writeRaw(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	io.WriteString(w, body)
}

func envelope(data string) string { return `{"contractVersion":"1.0.0","data":` + data + `}` }

func page(items []string, next string) string {
	n := "null"
	if next != "" {
		n = `"` + next + `"`
	}
	return fmt.Sprintf(`{"contractVersion":"1.0.0","data":[%s],"nextCursor":%s,"total":null}`, strings.Join(items, ","), n)
}

func errJSON(code, msg string) string {
	return fmt.Sprintf(`{"contractVersion":"1.0.0","error":{"code":"%s","message":"%s","requestId":"req-1","domain":null,"source":null,"retryable":false,"retryAt":null,"details":null}}`, code, msg)
}

type jobSpec struct {
	id, typ, state            string
	total, finished, unresolv int
	outcomes                  string
	seq                       int
}

func jobJSON(s jobSpec) string {
	if s.id == "" {
		s.id = jobID
	}
	if s.typ == "" {
		s.typ = "registry_scan"
	}
	if s.outcomes == "" {
		s.outcomes = "{}"
	}
	return fmt.Sprintf(`{"id":"%s","type":"%s","state":"%s","label":null,"createdAt":"2026-10-05T10:00:00.000Z","startedAt":null,"finishedAt":null,"updatedAt":"2026-10-05T10:00:%02d.000Z","counters":{"total":%d,"pending":0,"running":0,"finished":%d,"interrupted":0,"resolved":%d,"unresolved":%d,"outcomes":%s},"destinations":["https://rdap.verisign.com/com/v1/"],"input":{"extensions":["com"],"providerIds":[],"services":[],"checks":[],"rows":1,"text":null},"watchId":null,"parentJobId":null,"nextRetryAt":null}`,
		s.id, s.typ, s.state, s.seq%60, s.total, s.finished, s.finished-s.unresolv, s.unresolv, s.outcomes)
}

func itemJSON(subject, outcome string, resolved bool) string {
	return fmt.Sprintf(`{"id":"%s","jobId":"%s","subject":"%s","unicode":"%s","suffix":"com","operation":"registry","target":null,"state":"finished","attempts":1,"outcome":"%s","resolved":%t,"error":null,"retryAt":null,"startedAt":null,"finishedAt":null,"evidence":{"registry":null,"confirmation":null,"offers":[],"nameCheck":null,"diagnostic":null,"listing":null},"bestPrice":null,"collectionIds":[]}`,
		"44444444-4444-4444-8444-"+fmt.Sprintf("%012d", len(subject)), jobID, subject, subject, outcome, resolved)
}

// sse writes events on the response and keeps the stream open until the
// client disconnects.
func sseHandler(events ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		for _, e := range events {
			io.WriteString(w, e)
		}
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}
}

func sseEvent(id, typ, job, payload string) string {
	jobField := "null"
	if job != "" {
		jobField = `"` + job + `"`
	}
	return fmt.Sprintf("id: %s\nevent: %s\ndata: {\"contractVersion\":\"1.0.0\",\"eventId\":\"%s\",\"type\":\"%s\",\"occurredAt\":\"2026-10-05T10:00:00.000Z\",\"jobId\":%s,\"watchId\":null,\"payload\":%s}\n\n",
		id, typ, id, typ, jobField, payload)
}

type result struct {
	stdout, stderr string
	code           int
}

type harness struct {
	t     *testing.T
	env   map[string]string
	stdin string
	ctx   context.Context
	app   func(a *App)
}

func newHarness(t *testing.T) *harness {
	return &harness{t: t, ctx: context.Background(), env: map[string]string{
		EnvAPIToken:             testToken,
		"DOMAIN_SCOUT_DATA_DIR": filepath.Join(t.TempDir(), "data"),
	}}
}

func (h *harness) run(args ...string) result {
	h.t.Helper()
	var stdout, stderr bytes.Buffer
	home := h.t.TempDir()
	a := &App{
		Stdin:        strings.NewReader(h.stdin),
		Stdout:       &stdout,
		Stderr:       &stderr,
		Getenv:       func(k string) string { return h.env[k] },
		GOOS:         "linux",
		Executable:   filepath.Join(home, "bin", "domain-scout"),
		Cwd:          home,
		Home:         home,
		LookPath:     func(string) (string, error) { return "", os.ErrNotExist },
		PollInterval: 10 * time.Millisecond,
		Version:      "test",
	}
	if h.app != nil {
		h.app(a)
	}
	code := a.Run(h.ctx, args)
	return result{stdout: stdout.String(), stderr: stderr.String(), code: code}
}

// api runs a command against the fake via --backend-url.
func (h *harness) api(f *fakeAPI, args ...string) result {
	h.t.Helper()
	return h.run(append([]string{"--backend-url", f.srv.URL}, args...)...)
}

func expectCode(t *testing.T, r result, want int) {
	t.Helper()
	if r.code != want {
		t.Fatalf("exit %d, want %d\nstdout: %s\nstderr: %s", r.code, want, r.stdout, r.stderr)
	}
}

func decodeJSON(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, s)
	}
	return m
}
