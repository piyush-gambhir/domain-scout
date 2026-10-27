package cli

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
	"github.com/piyush-gambhir/domain-scout/cli/internal/runtime"
)

func listJobs(ctx context.Context, g *api.Client) (*http.Response, error) {
	return g.ListJobs(ctx, &api.ListJobsParams{})
}

// A backend that stopped itself (idle) or refuses as "stopping" is replaced
// and the request sent once more to the new one.
func TestClientRevivesAStoppedBackend(t *testing.T) {
	served := func(name string) *httptest.Server {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeRaw(w, 200, `{"contractVersion":"1.0.0","data":[],"nextCursor":null,"total":0,"from":"`+name+`"}`)
		}))
		t.Cleanup(srv.Close)
		return srv
	}
	stopping := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeRaw(w, 503, errJSON("unavailable", "The backend is stopping"))
	}))
	t.Cleanup(stopping.Close)
	gone := httptest.NewServer(http.NotFoundHandler())
	goneURL := gone.URL
	gone.Close()

	for _, tc := range []struct{ name, first string }{{"stopping", stopping.URL}, {"gone", goneURL}} {
		t.Run(tc.name, func(t *testing.T) {
			next := served("new")
			c := newAPIClient(tc.first, testToken, "old-instance", 5*time.Second, "test")
			var revived []string
			c.revive = func(ctx context.Context, gone string) (string, string, string, error) {
				revived = append(revived, gone)
				return next.URL, testToken, "new-instance", nil
			}
			res, err := c.do(context.Background(), listJobs)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(res.body), `"from":"new"`) || len(revived) != 1 || revived[0] != "old-instance" {
				t.Fatalf("body %s, revived %v", res.body, revived)
			}
			if c.baseURL() != next.URL {
				t.Fatalf("client should keep using the new backend, has %s", c.baseURL())
			}
		})
	}
}

// Other unavailable errors are not a stopped backend: no revive, no resend.
func TestClientDoesNotReviveForOtherErrors(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeRaw(w, 503, errJSON("unavailable", "IANA bootstrap refresh failed"))
	}))
	t.Cleanup(srv.Close)
	c := newAPIClient(srv.URL, testToken, "instance", 5*time.Second, "test")
	c.revive = func(context.Context, string) (string, string, string, error) {
		t.Fatal("revive must not run")
		return "", "", "", nil
	}
	if _, err := c.do(context.Background(), listJobs); err == nil || calls.Load() != 1 {
		t.Fatalf("err %v after %d calls", err, calls.Load())
	}
}

// installedBackend lays out a packaged install whose backend is this test
// binary (fakenode) and returns a harness using it.
func installedBackend(t *testing.T, env ...string) (*harness, string) {
	t.Helper()
	if os.Getenv("GOOS") == "windows" {
		t.Skip("POSIX only")
	}
	prefix := t.TempDir()
	full := filepath.Join(prefix, "lib", "backend", "dist", "main.js")
	os.MkdirAll(filepath.Dir(full), 0o755)
	os.WriteFile(full, []byte("//\n"), 0o644)
	dataDir := filepath.Join(t.TempDir(), "data")
	h := newHarness(t)
	delete(h.env, EnvAPIToken)
	h.env["DOMAIN_SCOUT_NODE"] = os.Args[0]
	h.env["DOMAIN_SCOUT_PORT"] = itoa(freePort(t))
	h.app = func(a *App) {
		a.Executable = filepath.Join(prefix, "bin", "domain-scout")
		a.LauncherEnv = append([]string{"FAKE_NODE=1"}, env...)
	}
	t.Cleanup(func() { killFromFile(filepath.Join(dataDir, "run", "backend.json")) })
	return h, dataDir
}

func runningInstance(t *testing.T, dataDir string) string {
	t.Helper()
	info, err := runtime.ReadBackendInfo(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	return info.InstanceID
}

// A command racing the backend's idle stop gets its answer from a new backend.
func TestCommandSurvivesTheBackendStoppingWhenIdle(t *testing.T) {
	h, dataDir := installedBackend(t, "FAKE_NODE_STOP_ONCE=GET /api/v1/jobs")
	expectCode(t, h.run("--data-dir", dataDir, "service", "start"), ExitOK)
	first := runningInstance(t, dataDir)
	r := h.run("--data-dir", dataDir, "jobs", "list")
	expectCode(t, r, ExitOK)
	if !strings.Contains(r.stdout, `"data":[]`) || !strings.Contains(r.stderr, "Starting the Domain Scout backend") {
		t.Fatalf("stdout %q stderr %q", r.stdout, r.stderr)
	}
	if runningInstance(t, dataDir) == first {
		t.Fatal("a new backend should be running")
	}
}

func TestNewerCLIReplacesAnOlderIdleBackend(t *testing.T) {
	h, dataDir := installedBackend(t, "FAKE_NODE_APP_VERSION=0.9.0")
	expectCode(t, h.run("--data-dir", dataDir, "service", "start"), ExitOK)
	first := runningInstance(t, dataDir)
	app := h.app
	h.app = func(a *App) { app(a); a.Version = "1.0.0" }
	r := h.run("--data-dir", dataDir, "jobs", "list")
	expectCode(t, r, ExitOK)
	if !strings.Contains(r.stderr, "Restarting the backend: version 0.9.0 was running, this CLI is 1.0.0.") {
		t.Fatalf("stderr %q", r.stderr)
	}
	if runningInstance(t, dataDir) == first {
		t.Fatal("the older backend should have been replaced")
	}
	// service status never restarts anything.
	second := runningInstance(t, dataDir)
	expectCode(t, h.run("--data-dir", dataDir, "service", "status"), ExitOK)
	if runningInstance(t, dataDir) != second {
		t.Fatal("status must not restart the backend")
	}
}

// The replacement starts on the port the old backend used, not the default.
func TestReplacementKeepsTheOldBackendsPort(t *testing.T) {
	h, dataDir := installedBackend(t, "FAKE_NODE_APP_VERSION=0.9.0")
	custom := freePort(t)
	expectCode(t, h.run("--data-dir", dataDir, "service", "start", "--port", itoa(custom)), ExitOK)
	app := h.app
	h.app = func(a *App) { app(a); a.Version = "1.0.0" }
	expectCode(t, h.run("--data-dir", dataDir, "jobs", "list"), ExitOK)
	info, err := runtime.ReadBackendInfo(dataDir)
	if err != nil || !strings.HasSuffix(info.URL, ":"+itoa(custom)) {
		t.Fatalf("replacement should listen on %d: %+v %v", custom, info, err)
	}
}

func TestNewerCLIKeepsABusyOlderBackend(t *testing.T) {
	h, dataDir := installedBackend(t, "FAKE_NODE_APP_VERSION=0.9.0", "FAKE_NODE_BUSY=1")
	expectCode(t, h.run("--data-dir", dataDir, "service", "start"), ExitOK)
	first := runningInstance(t, dataDir)
	app := h.app
	h.app = func(a *App) { app(a); a.Version = "1.0.0" }
	r := h.run("--data-dir", dataDir, "jobs", "list")
	expectCode(t, r, ExitOK)
	if !strings.Contains(r.stderr, "keeps running for now: The backend is busy: 1 unfinished job. Version 1.0.0 starts once it is idle") {
		t.Fatalf("stderr %q", r.stderr)
	}
	if runningInstance(t, dataDir) != first {
		t.Fatal("a busy backend must keep running")
	}
}

// A backend that predates conditional stop would stop unconditionally, and a
// CLI that cannot start its own backend must not stop the working one.
func TestNewerCLIKeepsAnOlderBackendItCannotReplaceSafely(t *testing.T) {
	for _, tc := range []struct {
		name, env, want string
		noNode          bool
	}{
		{name: "no conditional stop", env: "FAKE_NODE_NO_CONDITIONAL_STOP=1", want: "cannot be replaced safely while it runs"},
		{name: "no node for the replacement", noNode: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := []string{"FAKE_NODE_APP_VERSION=0.9.0"}
			if tc.env != "" {
				env = append(env, tc.env)
			}
			h, dataDir := installedBackend(t, env...)
			expectCode(t, h.run("--data-dir", dataDir, "service", "start"), ExitOK)
			first := runningInstance(t, dataDir)
			app := h.app
			h.app = func(a *App) { app(a); a.Version = "1.0.0" }
			if tc.noNode {
				h.env["DOMAIN_SCOUT_NODE"] = filepath.Join(t.TempDir(), "no-node")
			}
			r := h.run("--data-dir", dataDir, "jobs", "list")
			expectCode(t, r, ExitOK)
			if !strings.Contains(r.stderr, tc.want) || strings.Contains(r.stderr, "Restarting") || runningInstance(t, dataDir) != first {
				t.Fatalf("the older backend must keep running; stderr %q", r.stderr)
			}
		})
	}
}

func TestOlderCLINeverReplacesANewerBackend(t *testing.T) {
	h, dataDir := installedBackend(t, "FAKE_NODE_APP_VERSION=2.0.0")
	expectCode(t, h.run("--data-dir", dataDir, "service", "start"), ExitOK)
	first := runningInstance(t, dataDir)
	app := h.app
	h.app = func(a *App) { app(a); a.Version = "1.0.0" }
	r := h.run("--data-dir", dataDir, "jobs", "list")
	expectCode(t, r, ExitOK)
	if !strings.Contains(r.stderr, "newer than this CLI (1.0.0)") || runningInstance(t, dataDir) != first {
		t.Fatalf("stderr %q", r.stderr)
	}
}

func TestCompareVersions(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		cmp  int
		ok   bool
	}{
		{"1.0.0", "0.9.9", 1, true},
		{"v0.2.0", "0.10.0", -1, true},
		{"1.2.3-rc.1", "1.2.3", 0, true},
		{"dev", "1.0.0", 0, false},
		{"1.0.0", "0.0.0-fake", 1, true},
	} {
		if cmp, ok := compareVersions(tc.a, tc.b); cmp != tc.cmp || ok != tc.ok {
			t.Errorf("compareVersions(%q, %q) = %d, %v", tc.a, tc.b, cmp, ok)
		}
	}
}
