package launcher

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/piyush-gambhir/domain-scout/cli/internal/fakenode"
	"github.com/piyush-gambhir/domain-scout/cli/internal/runtime"
)

func TestMain(m *testing.M) {
	fakenode.Main()
	os.Exit(m.Run())
}

func TestParseNodeVersion(t *testing.T) {
	cases := map[string][3]int{"v24.11.0\n": {24, 11, 0}, "24.19.3": {24, 19, 3}, "v26.0.0-nightly": {26, 0, 0}}
	for in, want := range cases {
		got, err := ParseNodeVersion(in)
		if err != nil || got != want {
			t.Fatalf("%q: got %v %v", in, got, err)
		}
	}
	if _, err := ParseNodeVersion("node"); err == nil {
		t.Fatal("garbage must fail")
	}
	if !VersionAtLeast([3]int{26, 0, 0}, MinNode) || VersionAtLeast([3]int{25, 9, 9}, MinNode) || !VersionAtLeast([3]int{27, 0, 0}, MinNode) {
		t.Fatal("version comparison wrong")
	}
}

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("// test\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func noEnv(string) string { return "" }

func TestFindBackendEntry(t *testing.T) {
	root := t.TempDir()

	// Packaged layout: <prefix>/bin/domain-scout and <prefix>/lib/backend/dist/main.js.
	pkg := filepath.Join(root, "pkg")
	touch(t, filepath.Join(pkg, "lib", "backend", "dist", "main.js"))
	c := &Config{Getenv: noEnv, Executable: filepath.Join(pkg, "bin", "domain-scout"), Cwd: root}
	got, err := c.FindBackendEntry()
	if err != nil || got != filepath.Join(pkg, "lib", "backend", "dist", "main.js") {
		t.Fatalf("packaged: %q %v", got, err)
	}

	// Repository layout found by walking up from the working directory.
	repo := filepath.Join(root, "repo")
	touch(t, filepath.Join(repo, "apps", "backend", "dist", "main.js"))
	c = &Config{Getenv: noEnv, Executable: filepath.Join(root, "elsewhere", "domain-scout"), Cwd: filepath.Join(repo, "apps", "cli", "internal")}
	got, err = c.FindBackendEntry()
	if err != nil || got != filepath.Join(repo, "apps", "backend", "dist", "main.js") {
		t.Fatalf("repo walk from cwd: %q %v", got, err)
	}
	// ...and from the executable (apps/cli/bin/domain-scout).
	c = &Config{Getenv: noEnv, Executable: filepath.Join(repo, "apps", "cli", "bin", "domain-scout"), Cwd: root}
	if got, err = c.FindBackendEntry(); err != nil || !strings.HasPrefix(got, repo) {
		t.Fatalf("repo walk from exe: %q %v", got, err)
	}

	// The environment override wins and must exist.
	override := filepath.Join(root, "custom", "main.js")
	touch(t, override)
	env := func(k string) string {
		if k == EnvBackendEntry {
			return override
		}
		return ""
	}
	c = &Config{Getenv: env, Executable: filepath.Join(pkg, "bin", "domain-scout")}
	if got, err = c.FindBackendEntry(); err != nil || got != override {
		t.Fatalf("override: %q %v", got, err)
	}
	c.Getenv = func(k string) string { return filepath.Join(root, "missing.js") }
	var se *SetupError
	if _, err = c.FindBackendEntry(); !errors.As(err, &se) {
		t.Fatalf("missing override must be a setup error, got %v", err)
	}

	c = &Config{Getenv: noEnv, Executable: filepath.Join(root, "x", "bin", "domain-scout"), Cwd: filepath.Join(root, "x")}
	if _, err = c.FindBackendEntry(); !errors.As(err, &se) || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("absent assets must be a setup error, got %v", err)
	}
}

func fakeNodeEnv(extra ...string) []string {
	return append([]string{fakenode.EnvActive + "=1"}, extra...)
}

func selfEnv(k string) string {
	if k == EnvNode {
		return os.Args[0]
	}
	return ""
}

func TestFindNodeChecksVersion(t *testing.T) {
	ctx := context.Background()
	c := &Config{Getenv: selfEnv, Env: fakeNodeEnv()}
	if _, err := c.FindNode(ctx); err != nil {
		t.Fatalf("26.12.1 should be accepted: %v", err)
	}
	c.Env = fakeNodeEnv(fakenode.EnvVersion + "=v24.21.0")
	var se *SetupError
	if _, err := c.FindNode(ctx); !errors.As(err, &se) || !strings.Contains(err.Error(), "26.0.0 or newer") {
		t.Fatalf("old node must be a setup error naming the minimum, got %v", err)
	}
	c = &Config{Getenv: noEnv, LookPath: func(string) (string, error) { return "", exec.ErrNotFound }}
	if _, err := c.FindNode(ctx); !errors.As(err, &se) || !strings.Contains(err.Error(), "not found on PATH") {
		t.Fatalf("missing node must be a setup error, got %v", err)
	}
}

func TestBrowserCommand(t *testing.T) {
	u := "http://127.0.0.1:3000/auth/bootstrap?code=x"
	if n, a := BrowserCommand("darwin", u); n != "open" || a[0] != u {
		t.Fatal(n, a)
	}
	if n, a := BrowserCommand("linux", u); n != "xdg-open" || a[0] != u {
		t.Fatal(n, a)
	}
	if n, a := BrowserCommand("windows", u); n != "rundll32" || a[0] != "url.dll,FileProtocolHandler" || a[1] != u {
		t.Fatal(n, a)
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

func killLater(t *testing.T, pid int) {
	t.Cleanup(func() {
		if p, err := os.FindProcess(pid); err == nil {
			_ = p.Kill()
		}
	})
}

func packagedConfig(t *testing.T) *Config {
	t.Helper()
	if goruntime.GOOS == "windows" {
		t.Skip("spawn tests use POSIX signals for cleanup")
	}
	prefix := t.TempDir()
	touch(t, filepath.Join(prefix, "lib", "backend", "dist", "main.js"))
	touch(t, filepath.Join(prefix, "lib", "web", "server.js"))
	return &Config{
		DataDir:      filepath.Join(t.TempDir(), "data"),
		Getenv:       selfEnv,
		Executable:   filepath.Join(prefix, "bin", "domain-scout"),
		Env:          fakeNodeEnv(),
		Timeout:      10 * time.Second,
		PollInterval: 20 * time.Millisecond,
	}
}

func TestStartBackendDetachedAndDiscoverable(t *testing.T) {
	c := packagedConfig(t)
	ctx := context.Background()
	if _, _, err := c.Discover(ctx); !errors.Is(err, runtime.ErrUnreachable) {
		t.Fatalf("nothing should be running yet: %v", err)
	}
	port := freePort(t)
	info, h, err := c.StartBackend(ctx, port, []string{"http://127.0.0.1:3999"})
	if err != nil {
		t.Fatal(err)
	}
	killLater(t, info.PID)
	if h.Response.Data.InstanceId.String() != info.InstanceID || !strings.HasSuffix(info.URL, ":"+itoa(port)) {
		t.Fatalf("unexpected backend %+v", info)
	}
	if !ProcessAlive(info.PID) {
		t.Fatal("backend process should be alive")
	}
	if _, _, err := c.Discover(ctx); err != nil {
		t.Fatalf("a started backend must be discoverable: %v", err)
	}
	log, _ := os.ReadFile(filepath.Join(c.DataDir, "logs", "backend.log"))
	if !strings.Contains(string(log), "--port "+itoa(port)) || !strings.Contains(string(log), "--web-origin http://127.0.0.1:3999") {
		t.Fatalf("log should record the launch command, got %q", log)
	}

	// The port is now taken: a second start reports the conflict without spawning.
	c2 := packagedConfig(t)
	var se *SetupError
	if _, _, err := c2.StartBackend(ctx, port, nil); !errors.As(err, &se) || !strings.Contains(err.Error(), "in use") {
		t.Fatalf("port conflict must be a setup error, got %v", err)
	}
}

func TestStartBackendProtocolMismatch(t *testing.T) {
	c := packagedConfig(t)
	c.Env = fakeNodeEnv(fakenode.EnvProtocol + "=2")
	_, _, err := c.StartBackend(context.Background(), freePort(t), nil)
	var se *SetupError
	if !errors.As(err, &se) || !strings.Contains(err.Error(), "protocol") {
		t.Fatalf("want protocol setup error, got %v", err)
	}
	if info, rerr := runtime.ReadBackendInfo(c.DataDir); rerr == nil {
		killLater(t, info.PID)
	}
}

func TestEnsureWebStartsPackagedServerAndReuses(t *testing.T) {
	c := packagedConfig(t)
	ctx := context.Background()
	port := freePort(t)
	url, err := c.EnsureWeb(ctx, "http://127.0.0.1:4317", port)
	if err != nil {
		t.Fatal(err)
	}
	info, err := runtime.ReadWebInfo(c.DataDir)
	if err != nil || info.URL != url {
		t.Fatalf("web.json %+v %v", info, err)
	}
	killLater(t, info.PID)
	again, err := c.EnsureWeb(ctx, "http://127.0.0.1:4317", port)
	if err != nil || again != url {
		t.Fatalf("running UI should be reused: %q %v", again, err)
	}
	after, _ := runtime.ReadWebInfo(c.DataDir)
	if after.PID != info.PID {
		t.Fatal("reuse must not start a second server")
	}
}

func TestWebAssetsMissingOrUnbuilt(t *testing.T) {
	root := t.TempDir()
	c := &Config{Getenv: noEnv, Executable: filepath.Join(root, "bin", "domain-scout"), Cwd: root}
	var se *SetupError
	if _, _, err := c.webCommand(3000); !errors.As(err, &se) {
		t.Fatalf("want setup error, got %v", err)
	}
	touch(t, filepath.Join(root, "apps", "web", "node_modules", "next", "dist", "bin", "next"))
	if _, _, err := c.webCommand(3000); err == nil || !strings.Contains(err.Error(), "not built") {
		t.Fatalf("unbuilt web must say so, got %v", err)
	}
	touch(t, filepath.Join(root, "apps", "web", ".next", "BUILD_ID"))
	args, dir, err := c.webCommand(3001)
	if err != nil || dir != filepath.Join(root, "apps", "web") || strings.Join(args[1:], " ") != "start -H 127.0.0.1 -p 3001" {
		t.Fatalf("repo next start: %v %q %v", args, dir, err)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

func TestEnsureWebReplacesServerForOtherPortOrBackend(t *testing.T) {
	c := packagedConfig(t)
	ctx := context.Background()
	first, err := c.EnsureWeb(ctx, "http://127.0.0.1:4317", freePort(t))
	if err != nil {
		t.Fatal(err)
	}
	old, _ := runtime.ReadWebInfo(c.DataDir)
	killLater(t, old.PID)
	if old.BackendURL != "http://127.0.0.1:4317" {
		t.Fatalf("web.json should record the backend: %+v", old)
	}

	// Same port, different backend: replaced.
	port := portOf(t, first)
	if _, err := c.EnsureWeb(ctx, "http://127.0.0.1:4400", port); err != nil {
		t.Fatal(err)
	}
	second, _ := runtime.ReadWebInfo(c.DataDir)
	killLater(t, second.PID)
	if second.PID == old.PID || second.BackendURL != "http://127.0.0.1:4400" || ProcessAlive(old.PID) {
		t.Fatalf("server for the old backend must be replaced: old %+v new %+v", old, second)
	}

	// Different port: replaced too.
	newPort := freePort(t)
	url, err := c.EnsureWeb(ctx, "http://127.0.0.1:4400", newPort)
	if err != nil || portOf(t, url) != newPort {
		t.Fatalf("%q %v", url, err)
	}
	third, _ := runtime.ReadWebInfo(c.DataDir)
	killLater(t, third.PID)
	if ProcessAlive(second.PID) {
		t.Fatal("server on the old port must be stopped")
	}
}

func TestEnsureWebFailureLeavesNoProcess(t *testing.T) {
	c := packagedConfig(t)
	c.Timeout = 300 * time.Millisecond
	c.Env = fakeNodeEnv(fakenode.EnvWebDelay + "=1500")
	port := freePort(t)
	var se *SetupError
	if _, err := c.EnsureWeb(context.Background(), "http://127.0.0.1:4317", port); !errors.As(err, &se) {
		t.Fatalf("want a setup error, got %v", err)
	}
	time.Sleep(2 * time.Second) // past the fake server's listen delay
	if !PortFree("127.0.0.1", port) {
		t.Fatal("an unready UI server was left running")
	}
	if _, err := runtime.ReadWebInfo(c.DataDir); err == nil {
		t.Fatal("web.json must not be written for a failed start")
	}
}

func portOf(t *testing.T, url string) int {
	t.Helper()
	i := strings.LastIndex(url, ":")
	p, err := strconv.Atoi(url[i+1:])
	if err != nil {
		t.Fatal(err)
	}
	return p
}
