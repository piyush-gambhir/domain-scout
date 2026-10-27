// Package launcher locates installed backend and web assets, checks the Node
// runtime and starts detached local servers. It never downloads anything.
package launcher

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/piyush-gambhir/domain-scout/cli/internal/runtime"
)

// Environment variables understood by the launcher.
const (
	EnvBackendEntry = "DOMAIN_SCOUT_BACKEND_ENTRY"
	EnvNode         = "DOMAIN_SCOUT_NODE"
	EnvPort         = "DOMAIN_SCOUT_PORT"
)

// DefaultPort and DefaultWebPort are the loopback ports from the runtime protocol.
const (
	DefaultPort    = 4317
	DefaultWebPort = 3000
)

// MinNode is the oldest supported Node.js version.
var MinNode = [3]int{24, 11, 0}

// SetupError is a backend setup or version failure (CLI exit code 5).
type SetupError struct{ Msg string }

func (e *SetupError) Error() string { return e.Msg }

func setupErr(format string, args ...any) error {
	return &SetupError{Msg: fmt.Sprintf(format, args...)}
}

// Config carries everything the launcher reads from the environment so tests
// can inject it.
type Config struct {
	DataDir    string
	Getenv     func(string) string
	LookPath   func(string) (string, error)
	Executable string // resolved path of the running CLI binary
	Cwd        string
	// Env is appended to the inherited environment of spawned processes.
	Env []string
	// Timeout bounds how long startup waits for a server to become ready.
	Timeout time.Duration
	// Progress receives human progress lines for stderr; nil discards them.
	Progress func(format string, args ...any)
	// PollInterval between readiness checks; zero means 100ms.
	PollInterval time.Duration
}

func (c *Config) progress(format string, args ...any) {
	if c.Progress != nil {
		c.Progress(format, args...)
	}
}

func (c *Config) poll() time.Duration {
	if c.PollInterval > 0 {
		return c.PollInterval
	}
	return 100 * time.Millisecond
}

func (c *Config) timeout() time.Duration {
	if c.Timeout > 0 {
		return c.Timeout
	}
	return 30 * time.Second
}

var probeClient = &http.Client{Timeout: 3 * time.Second}

// Discover returns the verified running backend for the data directory, or
// runtime.ErrUnreachable when none is running. Identity and protocol
// mismatches are returned as errors.
func (c *Config) Discover(ctx context.Context) (*runtime.BackendInfo, *runtime.Health, error) {
	info, err := runtime.ReadBackendInfo(c.DataDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil, runtime.ErrUnreachable
		}
		return nil, nil, setupErr("cannot read the backend runtime file: %v", err)
	}
	h, err := runtime.Verify(ctx, probeClient, info)
	if err != nil {
		return info, nil, err
	}
	return info, h, nil
}

var nodeVersionRe = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)`)

// ParseNodeVersion parses `node --version` output such as "v26.12.1".
func ParseNodeVersion(s string) ([3]int, error) {
	m := nodeVersionRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return [3]int{}, fmt.Errorf("unrecognized Node.js version %q", strings.TrimSpace(s))
	}
	var v [3]int
	for i := range v {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v, nil
}

// VersionAtLeast compares semantic version triples.
func VersionAtLeast(v, min [3]int) bool {
	for i := range v {
		if v[i] != min[i] {
			return v[i] > min[i]
		}
	}
	return true
}

func minNodeString() string { return fmt.Sprintf("%d.%d.%d", MinNode[0], MinNode[1], MinNode[2]) }

// FindNode locates node (DOMAIN_SCOUT_NODE, then PATH) and checks its version.
func (c *Config) FindNode(ctx context.Context) (string, error) {
	path := c.Getenv(EnvNode)
	if path == "" {
		p, err := c.LookPath("node")
		if err != nil {
			return "", setupErr("Node.js %s or newer is required but `node` was not found on PATH. Install it from https://nodejs.org or set %s to the node executable.", minNodeString(), EnvNode)
		}
		path = p
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	cmd.Env = append(os.Environ(), c.Env...)
	out, err := cmd.Output()
	if err != nil {
		return "", setupErr("cannot run %s --version: %v. Set %s to a working Node.js %s or newer.", path, err, EnvNode, minNodeString())
	}
	v, err := ParseNodeVersion(string(out))
	if err != nil {
		return "", setupErr("%v from %s", err, path)
	}
	if !VersionAtLeast(v, MinNode) {
		return "", setupErr("Node.js %s or newer is required; %s is %d.%d.%d. Install a newer Node.js or set %s.", minNodeString(), path, v[0], v[1], v[2], EnvNode)
	}
	return path, nil
}

// searchRoots returns the executable directory and the working directory with
// all their ancestors, nearest first, without duplicates.
func (c *Config) searchRoots() []string {
	var roots []string
	seen := map[string]bool{}
	for _, start := range []string{filepath.Dir(c.Executable), c.Cwd} {
		if start == "" || start == "." {
			continue
		}
		dir := filepath.Clean(start)
		for {
			if !seen[dir] {
				seen[dir] = true
				roots = append(roots, dir)
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return roots
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// FindBackendEntry resolves the backend entry point: DOMAIN_SCOUT_BACKEND_ENTRY,
// the packaged layout <exeDir>/../lib/backend/dist/main.js, then a repository
// checkout containing apps/backend/dist/main.js above the executable or cwd.
func (c *Config) FindBackendEntry() (string, error) {
	if p := c.Getenv(EnvBackendEntry); p != "" {
		if !fileExists(p) {
			return "", setupErr("%s points to %s, which does not exist", EnvBackendEntry, p)
		}
		return filepath.Abs(p)
	}
	if c.Executable != "" {
		p := filepath.Join(filepath.Dir(c.Executable), "..", "lib", "backend", "dist", "main.js")
		if fileExists(p) {
			return filepath.Clean(p), nil
		}
	}
	for _, root := range c.searchRoots() {
		p := filepath.Join(root, "apps", "backend", "dist", "main.js")
		if fileExists(p) {
			return p, nil
		}
	}
	return "", setupErr("backend assets not found. Use a packaged release (lib/backend next to bin/), build the repository with `pnpm turbo run build --filter @domain-scout/backend`, or set %s to the backend main.js.", EnvBackendEntry)
}

// PortFree reports whether host:port can be bound right now.
func PortFree(host string, port int) bool {
	l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

// spawn starts a detached child with output appended to logPath.
func (c *Config) spawn(name string, args []string, dir string, env []string, logPath string) (*exec.Cmd, <-chan error, error) {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return nil, nil, setupErr("cannot create the log directory: %v", err)
	}
	logf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, nil, setupErr("cannot open %s: %v", logPath, err)
	}
	defer logf.Close()
	fmt.Fprintf(logf, "\n--- %s starting %s %s\n", time.Now().UTC().Format(time.RFC3339), name, strings.Join(args, " "))
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(append(os.Environ(), c.Env...), env...)
	cmd.Stdout = logf
	cmd.Stderr = logf
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return nil, nil, setupErr("cannot start %s: %v", name, err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	return cmd, exited, nil
}

// StartBackend starts the backend detached and waits until backend.json
// exists and the health endpoint verifies its identity.
func (c *Config) StartBackend(ctx context.Context, port int, webOrigins []string) (*runtime.BackendInfo, *runtime.Health, error) {
	entry, err := c.FindBackendEntry()
	if err != nil {
		return nil, nil, err
	}
	node, err := c.FindNode(ctx)
	if err != nil {
		return nil, nil, err
	}
	if !PortFree("127.0.0.1", port) {
		// Another CLI may be starting the backend for this data directory (it holds the lock and
		// listens before it publishes backend.json); an unrelated process fails at once.
		wait := time.Duration(0)
		if fileExists(filepath.Join(c.DataDir, "backend.lock")) {
			wait = otherStarterWait
		}
		if info, h, err := c.awaitOther(ctx, wait); err == nil {
			return info, h, nil
		}
		return nil, nil, setupErr("port %d on 127.0.0.1 is in use by another process. Stop that process or choose another port with --port or %s.", port, EnvPort)
	}
	args := []string{entry, "--data-dir", c.DataDir, "--port", strconv.Itoa(port)}
	for _, o := range webOrigins {
		args = append(args, "--web-origin", o)
	}
	logPath := filepath.Join(runtime.LogDir(c.DataDir), "backend.log")
	c.progress("Starting the Domain Scout backend on 127.0.0.1:%d (log: %s)", port, logPath)
	_, exited, err := c.spawn(node, args, filepath.Dir(entry), nil, logPath)
	if err != nil {
		return nil, nil, err
	}

	deadline := time.Now().Add(c.timeout())
	ticker := time.NewTicker(c.poll())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-exited:
			// Another process won the instance lock for this data directory: wait for it to be ready.
			wait := time.Duration(0)
			if strings.Contains(tailFile(logPath, 3), "is using this data directory") || strings.Contains(tailFile(logPath, 3), "locked by another Domain Scout backend") {
				wait = time.Until(deadline)
			}
			if info, h, err := c.awaitOther(ctx, wait); err == nil {
				return info, h, nil
			}
			return nil, nil, setupErr("the backend exited during startup. Last log lines from %s:\n%s", logPath, tailFile(logPath, 15))
		case <-ticker.C:
		}
		info, h, err := c.Discover(ctx)
		if err == nil {
			return info, h, nil
		}
		if errors.Is(err, runtime.ErrProtocolMismatch) {
			return nil, nil, setupErr("%v", err)
		}
		if time.Now().After(deadline) {
			return nil, nil, setupErr("the backend did not become ready within %s. See %s.", c.timeout(), logPath)
		}
	}
}

// otherStarterWait bounds waiting for a backend another process is starting.
const otherStarterWait = 5 * time.Second

// awaitOther polls for a verified backend started by another process, for up
// to wait (at least one attempt).
func (c *Config) awaitOther(ctx context.Context, wait time.Duration) (*runtime.BackendInfo, *runtime.Health, error) {
	deadline := time.Now().Add(wait)
	for {
		info, h, err := c.Discover(ctx)
		if err == nil || !time.Now().Before(deadline) || ctx.Err() != nil {
			return info, h, err
		}
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-time.After(c.poll()):
		}
	}
}

// webAnswers reports whether an HTTP server answers at url.
func webAnswers(ctx context.Context, url string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	client := &http.Client{
		Timeout:       2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return true
}

// webCommand resolves how to run the UI server: the packaged standalone
// server.js or a built repository checkout via `next start`.
func (c *Config) webCommand(port int) (args []string, dir string, err error) {
	if c.Executable != "" {
		server := filepath.Clean(filepath.Join(filepath.Dir(c.Executable), "..", "lib", "web", "server.js"))
		if fileExists(server) {
			return []string{server}, filepath.Dir(server), nil
		}
	}
	for _, root := range c.searchRoots() {
		web := filepath.Join(root, "apps", "web")
		next := filepath.Join(web, "node_modules", "next", "dist", "bin", "next")
		if !fileExists(next) {
			continue
		}
		if !fileExists(filepath.Join(web, ".next", "BUILD_ID")) {
			return nil, "", setupErr("the web UI in %s is not built. Run `pnpm turbo run build --filter @domain-scout/web` first.", web)
		}
		return []string{next, "start", "-H", "127.0.0.1", "-p", strconv.Itoa(port)}, web, nil
	}
	return nil, "", setupErr("web UI assets not found. The npm package is CLI-only; use a release archive (lib/web next to bin/), the Docker image or a built repository checkout for the UI.")
}

// EnsureWeb reuses the UI server recorded in web.json when it runs on the
// requested port and forwards to backendURL. A recorded server with another
// port or backend was started by this launcher, so it is replaced.
func (c *Config) EnsureWeb(ctx context.Context, backendURL string, port int) (string, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	if info, err := runtime.ReadWebInfo(c.DataDir); err == nil {
		running := ProcessAlive(info.PID) && webAnswers(ctx, info.URL)
		sameBackend := info.BackendURL == "" || info.BackendURL == backendURL
		if running && info.URL == url && sameBackend {
			return info.URL, nil
		}
		if running {
			c.progress("Restarting the UI server (it served %s for backend %s).", info.URL, info.BackendURL)
			stopProcess(info.PID)
		}
		runtime.RemoveWebInfo(c.DataDir)
	}
	if !PortFree("127.0.0.1", port) {
		return "", setupErr("port %d on 127.0.0.1 is in use by another process. Stop it or choose another UI port with --web-port.", port)
	}
	node, err := c.FindNode(ctx)
	if err != nil {
		return "", err
	}
	args, dir, err := c.webCommand(port)
	if err != nil {
		return "", err
	}
	logPath := filepath.Join(runtime.LogDir(c.DataDir), "web.log")
	c.progress("Starting the Domain Scout UI on %s (log: %s)", url, logPath)
	env := []string{
		"PORT=" + strconv.Itoa(port),
		"HOSTNAME=127.0.0.1",
		"DOMAIN_SCOUT_BACKEND_URL=" + backendURL,
	}
	cmd, exited, err := c.spawn(node, args, dir, env, logPath)
	if err != nil {
		return "", err
	}
	// Nothing records an unready UI server, so stop it on any failure rather
	// than leave an invisible process holding the port.
	fail := func(err error) (string, error) {
		_ = cmd.Process.Kill()
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
		}
		return "", err
	}
	deadline := time.Now().Add(c.timeout())
	ticker := time.NewTicker(c.poll())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return fail(ctx.Err())
		case <-exited:
			return "", setupErr("the UI server exited during startup. Last log lines from %s:\n%s", logPath, tailFile(logPath, 15))
		case <-ticker.C:
		}
		if webAnswers(ctx, url) {
			info := runtime.WebInfo{URL: url, PID: cmd.Process.Pid, BackendURL: backendURL}
			if err := runtime.WriteWebInfo(c.DataDir, info); err != nil {
				return fail(setupErr("cannot write web.json: %v", err))
			}
			return url, nil
		}
		if time.Now().After(deadline) {
			return fail(setupErr("the UI server did not answer within %s. See %s.", c.timeout(), logPath))
		}
	}
}

// stopProcess terminates a UI server this launcher recorded and waits
// briefly for it to exit.
func stopProcess(pid int) {
	p, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = p.Kill()
	for i := 0; i < 50 && ProcessAlive(pid); i++ {
		time.Sleep(100 * time.Millisecond)
	}
}

// BrowserCommand returns the OS command that opens url in the default browser.
func BrowserCommand(goos, url string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", []string{url}
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", url}
	default:
		return "xdg-open", []string{url}
	}
}

// OpenBrowser opens url with the OS opener without waiting for the browser.
func OpenBrowser(goos, url string) error {
	name, args := BrowserCommand(goos, url)
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func tailFile(path string, n int) string {
	f, err := os.Open(path)
	if err != nil {
		return "(no log output)"
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		lines = append(lines, sc.Text())
		if len(lines) > n {
			lines = lines[1:]
		}
	}
	if len(lines) == 0 {
		return "(no log output)"
	}
	return strings.Join(lines, "\n")
}
