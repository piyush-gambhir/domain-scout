// Package fakenode lets a Go test binary stand in for `node` when the
// launcher spawns the backend or web server. It is imported only by tests.
//
// A test sets DOMAIN_SCOUT_NODE to os.Args[0] and passes FAKE_NODE=1 in the
// child environment; TestMain calls Main, which takes over the process.
package fakenode

import (
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Env variables that control the fake.
const (
	EnvActive   = "FAKE_NODE"              // "1" enables the fake
	EnvVersion  = "FAKE_NODE_VERSION"      // `node --version` output (default v26.12.1)
	EnvProtocol = "FAKE_NODE_PROTOCOL"     // protocolVersion the fake backend reports (default 1)
	EnvWebDelay = "FAKE_NODE_WEB_DELAY_MS" // delay before the fake UI server listens
	Token       = "fake-token"
)

// Main runs the fake when enabled and never returns in that case.
func Main() {
	if os.Getenv(EnvActive) != "1" {
		return
	}
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "--version" {
		v := os.Getenv(EnvVersion)
		if v == "" {
			v = "v26.12.1"
		}
		fmt.Println(v)
		os.Exit(0)
	}
	if len(args) > 0 && strings.HasSuffix(args[0], "main.js") {
		backend(args[1:])
	}
	if len(args) > 0 && (strings.HasSuffix(args[0], "server.js") || strings.HasSuffix(args[0], "next")) {
		web()
	}
	fmt.Fprintln(os.Stderr, "fakenode: unexpected arguments", args)
	os.Exit(2)
}

func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func backend(args []string) {
	fs := flag.NewFlagSet("backend", flag.ExitOnError)
	dataDir := fs.String("data-dir", "", "")
	port := fs.Int("port", 4317, "")
	var origins multi
	fs.Var(&origins, "web-origin", "")
	_ = fs.Parse(args)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Port %d is already in use\n", *port)
		os.Exit(1)
	}
	run := filepath.Join(*dataDir, "run")
	_ = os.MkdirAll(run, 0o700)
	_ = os.WriteFile(filepath.Join(run, "api-token"), []byte(Token+"\n"), 0o600)
	protocol := 1
	if p := os.Getenv(EnvProtocol); p != "" {
		fmt.Sscan(p, &protocol)
	}
	instance := uuid()
	url := fmt.Sprintf("http://127.0.0.1:%d", *port)
	started := time.Now().UTC().Format(time.RFC3339)
	info := map[string]any{
		"url": url, "pid": os.Getpid(), "instanceId": instance, "protocolVersion": protocol,
		"contractVersion": "1.0.0", "version": "0.0.0-fake", "startedAt": started, "dataDir": *dataDir,
	}
	b, _ := json.Marshal(info)
	_ = os.WriteFile(filepath.Join(run, "backend.json"), b, 0o600)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"contractVersion": "1.0.0", "data": map[string]any{
			"status": "ok", "instanceId": instance, "protocolVersion": protocol, "contractVersion": "1.0.0",
			"version": "0.0.0-fake", "startedAt": started, "pid": os.Getpid(), "dataDir": *dataDir,
		}})
	})
	authed := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+Token {
				writeJSON(w, 401, map[string]any{"contractVersion": "1.0.0", "error": map[string]any{
					"code": "unauthorized", "message": "bad token", "requestId": "r", "domain": nil, "source": nil,
					"retryable": false, "retryAt": nil, "details": nil}})
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /api/v1/jobs", authed(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"contractVersion": "1.0.0", "data": []any{}, "nextCursor": nil, "total": 0})
	}))
	mux.HandleFunc("GET /api/v1/fake/origins", authed(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"contractVersion": "1.0.0", "data": origins})
	}))
	mux.HandleFunc("POST /api/v1/auth/bootstrap-codes", authed(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 201, map[string]any{"contractVersion": "1.0.0", "data": map[string]any{
			"code": "bootstrap-code-1234567890", "expiresAt": time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}})
	}))
	mux.HandleFunc("POST /api/v1/service/stop", authed(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 202, map[string]any{"contractVersion": "1.0.0", "data": map[string]any{"stopping": true, "graceMs": 100}})
		go func() {
			time.Sleep(50 * time.Millisecond)
			_ = os.Remove(filepath.Join(run, "backend.json"))
			os.Exit(0)
		}()
	}))
	_ = http.Serve(ln, mux)
	os.Exit(0)
}

func web() {
	if ms := os.Getenv(EnvWebDelay); ms != "" {
		var d int
		fmt.Sscan(ms, &d)
		time.Sleep(time.Duration(d) * time.Millisecond)
	}
	port := os.Getenv("PORT")
	backend := os.Getenv("DOMAIN_SCOUT_BACKEND_URL")
	ln, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		fmt.Fprintln(os.Stderr, "web port in use")
		os.Exit(1)
	}
	_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "fake web for %s", backend)
	}))
	os.Exit(0)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }
