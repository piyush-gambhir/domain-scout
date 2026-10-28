package runtime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"testing"
)

func envMap(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestDefaultDataDirPerOS(t *testing.T) {
	cases := []struct {
		name, goos, home string
		env              map[string]string
		want             string
	}{
		{"macOS", "darwin", "/Users/ada", nil, "/Users/ada/Library/Application Support/Domain Scout"},
		{"windows LOCALAPPDATA", "windows", `C:\Users\ada`, map[string]string{"LOCALAPPDATA": `C:\Users\ada\AppData\Local`}, `C:\Users\ada\AppData\Local\Domain Scout`},
		{"windows fallback", "windows", `C:\Users\ada`, nil, `C:\Users\ada\AppData\Local\Domain Scout`},
		{"linux XDG", "linux", "/home/ada", map[string]string{"XDG_DATA_HOME": "/data/xdg"}, "/data/xdg/domain-scout"},
		{"linux relative XDG ignored", "linux", "/home/ada", map[string]string{"XDG_DATA_HOME": "rel/xdg"}, "/home/ada/.local/share/domain-scout"},
		{"linux default", "linux", "/home/ada", nil, "/home/ada/.local/share/domain-scout"},
		{"freebsd uses XDG rules", "freebsd", "/home/ada", nil, "/home/ada/.local/share/domain-scout"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DefaultDataDir(tc.goos, envMap(tc.env), tc.home)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
	if _, err := DefaultDataDir("darwin", envMap(nil), ""); err == nil {
		t.Fatal("expected an error without a home directory")
	}
}

func TestResolveDataDirPrecedence(t *testing.T) {
	env := envMap(map[string]string{EnvDataDir: "/from/env"})
	got, _ := ResolveDataDir("/from/flag", "linux", env, "/home/ada")
	if want, _ := filepath.Abs("/from/flag"); got != want {
		t.Fatalf("flag should win, got %q", got)
	}
	got, _ = ResolveDataDir("", "linux", env, "/home/ada")
	if want, _ := filepath.Abs("/from/env"); got != want {
		t.Fatalf("env should win over the default, got %q", got)
	}
	got, _ = ResolveDataDir("", "linux", envMap(nil), "/home/ada")
	if got != "/home/ada/.local/share/domain-scout" {
		t.Fatalf("default expected, got %q", got)
	}
	got, _ = ResolveDataDir("relative/dir", "linux", envMap(nil), "/home/ada")
	if !filepath.IsAbs(got) {
		t.Fatalf("explicit paths must be absolute, got %q", got)
	}
}

func healthServer(t *testing.T, instance string, protocol int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/health" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("Authorization") != "" {
			t.Errorf("health must not carry the API token")
		}
		fmt.Fprintf(w, `{"contractVersion":"1.0.0","data":{"status":"ok","instanceId":"%s","protocolVersion":%d,"contractVersion":"1.0.0","version":"1.0.0","startedAt":"2026-10-05T10:00:00.000Z","pid":42,"dataDir":"/tmp/x"}}`, instance, protocol)
	}))
	t.Cleanup(srv.Close)
	return srv
}

const instanceA = "2f1c4f9e-8a59-4b8a-9d55-3b8e0d6b8a01"
const instanceB = "7d0a9a2e-1b2c-4d3e-8f40-5a6b7c8d9e0f"

func TestVerifyIdentity(t *testing.T) {
	ctx := context.Background()
	srv := healthServer(t, instanceA, 1)
	h, err := Verify(ctx, srv.Client(), &BackendInfo{URL: srv.URL, InstanceID: instanceA})
	if err != nil {
		t.Fatalf("matching identity rejected: %v", err)
	}
	if h.Response.Data.Pid != 42 || len(h.Raw) == 0 {
		t.Fatalf("health not decoded: %+v", h.Response)
	}
	if _, err := Verify(ctx, srv.Client(), &BackendInfo{URL: srv.URL, InstanceID: instanceB}); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("want ErrIdentityMismatch, got %v", err)
	}
	old := healthServer(t, instanceA, 2)
	if _, err := Verify(ctx, old.Client(), &BackendInfo{URL: old.URL, InstanceID: instanceA}); !errors.Is(err, ErrProtocolMismatch) {
		t.Fatalf("want ErrProtocolMismatch, got %v", err)
	}
	closed := httptest.NewServer(http.NotFoundHandler())
	url := closed.URL
	closed.Close()
	if _, err := Verify(ctx, http.DefaultClient, &BackendInfo{URL: url, InstanceID: instanceA}); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("want ErrUnreachable, got %v", err)
	}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "<html>") }))
	defer other.Close()
	if _, err := Verify(ctx, other.Client(), &BackendInfo{URL: other.URL, InstanceID: instanceA}); !errors.Is(err, ErrNotBackend) {
		t.Fatalf("want ErrNotBackend, got %v", err)
	}
}

func TestRuntimeFiles(t *testing.T) {
	dir := t.TempDir()
	if _, err := ReadBackendInfo(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing backend.json should be ErrNotExist, got %v", err)
	}
	run := RunDir(dir)
	if err := os.MkdirAll(run, 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(run, "backend.json"), []byte(`{"url":"http://127.0.0.1:4317","pid":7,"instanceId":"`+instanceA+`","protocolVersion":1}`), 0o600)
	os.WriteFile(filepath.Join(run, "api-token"), []byte("  tok-123\n"), 0o600)
	info, err := ReadBackendInfo(dir)
	if err != nil || info.PID != 7 || info.InstanceID != instanceA {
		t.Fatalf("bad info %+v %v", info, err)
	}
	tok, err := ReadToken(dir)
	if err != nil || tok != "tok-123" {
		t.Fatalf("token %q %v", tok, err)
	}
	if err := WriteWebInfo(dir, WebInfo{URL: "http://127.0.0.1:3000", PID: 9}); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(filepath.Join(run, "web.json"))
	if goruntime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatalf("web.json mode %v", st.Mode().Perm())
	}
	w, err := ReadWebInfo(dir)
	if err != nil || w.PID != 9 {
		t.Fatalf("web info %+v %v", w, err)
	}
}
