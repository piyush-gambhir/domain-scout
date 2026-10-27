// Package cli implements the domain-scout command tree. Every command maps to
// one or more local API operations; the CLI never scans or stores data itself.
package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/launcher"
	"github.com/piyush-gambhir/domain-scout/cli/internal/runtime"
)

// EnvAPIToken supplies the API token when --backend-url is used.
const EnvAPIToken = "DOMAIN_SCOUT_API_TOKEN"

// App holds the process environment so tests can run commands in-process.
type App struct {
	Stdin      io.Reader
	Stdout     io.Writer
	Stderr     io.Writer
	Getenv     func(string) string
	GOOS       string
	Executable string
	Cwd        string
	Home       string
	LookPath   func(string) (string, error)
	// OpenURL opens the browser; nil uses the OS opener.
	OpenURL func(url string) error
	// LauncherEnv is appended to the environment of spawned servers.
	LauncherEnv []string
	// PollInterval is the job polling fallback interval; zero means 1s.
	PollInterval time.Duration
	Version      string

	opts   options
	client *apiClient
	// webOrigins are passed to a backend this process starts (ui with a
	// non-default --web-port); started reports whether it started one.
	webOrigins []string
	started    bool
}

type options struct {
	output     string
	noInput    bool
	quiet      bool
	backendURL string
	dataDir    string
	timeout    time.Duration
}

// New wires an App to the real process environment.
func New(version string) *App {
	exe, _ := os.Executable()
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	cwd, _ := os.Getwd()
	home, _ := os.UserHomeDir()
	return &App{
		Stdin:      os.Stdin,
		Stdout:     os.Stdout,
		Stderr:     os.Stderr,
		Getenv:     os.Getenv,
		GOOS:       goruntime.GOOS,
		Executable: exe,
		Cwd:        cwd,
		Home:       home,
		LookPath:   exec.LookPath,
		Version:    version,
	}
}

// Run executes args and returns the process exit code.
func (a *App) Run(ctx context.Context, args []string) int {
	a.opts = options{output: outputJSON}
	root := a.rootCmd()
	root.SetArgs(args)
	root.SetIn(a.Stdin)
	root.SetOut(a.Stdout)
	root.SetErr(a.Stderr)
	cmd, err := root.ExecuteContextC(ctx)
	if err == nil {
		return ExitOK
	}
	var e *exitError
	if !errors.As(err, &e) {
		// Anything cobra rejects before our code runs is a usage error.
		path := root.Name()
		if cmd != nil {
			path = cmd.CommandPath()
		}
		e = &exitError{code: ExitUsage, errCode: "invalid_request", msg: fmt.Sprintf("%v. Run '%s --help' for usage.", err, path)}
	}
	mode := a.opts.output
	if !validOutput(mode) {
		mode = outputJSON
	}
	writeError(a.Stderr, mode, e, a.opts.quiet)
	return e.code
}

func validOutput(s string) bool {
	return s == outputJSON || s == outputTable || s == outputNDJSON
}

func (a *App) rootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "domain-scout",
		Short: "Local domain research: registry discovery, provider pricing and shortlists",
		Long: `domain-scout talks to the local Domain Scout backend, starting it when needed.

Output is the API JSON envelope (with contractVersion) on stdout by default.
--output ndjson prints one row per line; each object row carries the
envelope's contractVersion. Progress and errors go to stderr. Commands
never prompt.

Exit codes: 0 success or accepted submission, 1 local failure, 2 invalid
request or usage, 3 job finished with unresolved items, 4 provider access
missing, 5 backend setup or version failure, 130 interrupted wait.`,
		Version:           a.Version,
		SilenceErrors:     true,
		SilenceUsage:      true,
		CompletionOptions: cobra.CompletionOptions{HiddenDefaultCmd: true},
	}
	root.SetVersionTemplate("domain-scout {{.Version}}\n")
	pf := root.PersistentFlags()
	pf.StringVarP(&a.opts.output, "output", "o", outputJSON, "output format: json, table or ndjson (one row per line, each with contractVersion)")
	pf.BoolVar(&a.opts.noInput, "no-input", false, "never prompt (accepted for compatibility; the CLI never prompts)")
	pf.BoolVarP(&a.opts.quiet, "quiet", "q", false, "suppress progress messages on stderr")
	pf.StringVar(&a.opts.backendURL, "backend-url", "", "use this backend URL instead of runtime discovery (token from "+EnvAPIToken+" or the token file)")
	pf.StringVar(&a.opts.dataDir, "data-dir", "", "data directory (default: "+runtime.EnvDataDir+" or the OS application data directory)")
	pf.DurationVar(&a.opts.timeout, "timeout", 30*time.Second, "limit for each API request and for server startup")
	root.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error {
		return &exitError{code: ExitUsage, errCode: "invalid_request", msg: fmt.Sprintf("%v. Run '%s --help' for usage.", err, cmd.CommandPath())}
	})

	root.AddCommand(
		a.versionCmd(), a.mcpCmd(),
		a.serviceCmd(), a.uiCmd(),
		a.inputCmd(), a.scanCmd(), a.recheckCmd(), a.jobsCmd(), a.eventsCmd(),
		a.coverageCmd(), a.providersCmd(), a.catalogCmd(),
		a.providerCheckCmd(), a.quoteCmd(), a.transferCmd(), a.compareCmd(),
		a.aftermarketCmd(), a.nameCheckCmd(), a.diagnoseCmd(),
		a.shortlistCmd(), a.notesCmd(), a.criteriaCmd(), a.presetsCmd(), a.generateCmd(),
		a.watchesCmd(), a.noticesCmd(),
		a.historyCmd(), a.pricesCmd(), a.portfolioCmd(),
		a.exportCmd(), a.snapshotCmd(),
		a.dataCmd(), a.evidenceCmd(), a.settingsCmd(), a.capabilitiesCmd(),
	)
	return root
}

// runFunc is the body of a command.
type runFunc func(ctx context.Context, cmd *cobra.Command, args []string) error

// newCmd builds a leaf command whose errors are always typed exit errors.
func (a *App) newCmd(use, short string, args cobra.PositionalArgs, run runFunc) *cobra.Command {
	return &cobra.Command{
		Use:   use,
		Short: short,
		Args:  args,
		RunE: func(cmd *cobra.Command, posArgs []string) error {
			if !validOutput(a.opts.output) {
				return usageErr("invalid --output %q: use json, table or ndjson", a.opts.output)
			}
			if a.opts.timeout <= 0 {
				return usageErr("--timeout must be positive")
			}
			ctx := cmd.Context()
			err := run(ctx, cmd, posArgs)
			if err == nil {
				return nil
			}
			var e *exitError
			if errors.As(err, &e) {
				return e
			}
			if ctx.Err() != nil {
				return errInterrupted
			}
			return classify(err)
		},
	}
}

// group builds a parent command that only holds subcommands.
func group(use, short string, children ...*cobra.Command) *cobra.Command {
	g := &cobra.Command{Use: use, Short: short, Args: cobra.NoArgs}
	g.RunE = func(cmd *cobra.Command, args []string) error {
		return usageErr("%s needs a subcommand. Run '%s --help' for usage.", cmd.CommandPath(), cmd.CommandPath())
	}
	g.AddCommand(children...)
	return g
}

func (a *App) progress(format string, args ...any) {
	if a.opts.quiet {
		return
	}
	fmt.Fprintf(a.Stderr, format+"\n", args...)
}

func (a *App) dataDir() (string, error) {
	dir, err := runtime.ResolveDataDir(a.opts.dataDir, a.GOOS, a.Getenv, a.Home)
	if err != nil {
		return "", setupErr("cannot determine the data directory: %v. Pass --data-dir.", err)
	}
	return dir, nil
}

func (a *App) launcherConfig(dataDir string) *launcher.Config {
	return &launcher.Config{
		DataDir:    dataDir,
		Getenv:     a.Getenv,
		LookPath:   a.LookPath,
		Executable: a.Executable,
		Cwd:        a.Cwd,
		Env:        a.LauncherEnv,
		Timeout:    a.opts.timeout,
		Progress:   a.progress,
	}
}

// backendPort is DOMAIN_SCOUT_PORT or the protocol default.
func (a *App) backendPort() (int, error) {
	if v := a.Getenv(launcher.EnvPort); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p <= 0 || p > 65535 {
			return 0, usageErr("%s must be a port number, got %q", launcher.EnvPort, v)
		}
		return p, nil
	}
	return launcher.DefaultPort, nil
}

// connection is a verified backend plus its health response.
type connection struct {
	url    string
	health *runtime.Health
}

// connect finds a verified backend: --backend-url, or the runtime file for
// the data directory. With autostart it launches installed backend assets
// when none is running. The data directory is returned alongside an error
// only when no backend is running.
func (a *App) connect(ctx context.Context, autostart bool) (*connection, string, error) {
	dataDir, err := a.dataDir()
	if err != nil {
		return nil, "", err
	}
	if a.opts.backendURL != "" {
		url := strings.TrimRight(a.opts.backendURL, "/")
		h, err := runtime.FetchHealth(ctx, probeClient(), url)
		if err != nil {
			if ctx.Err() != nil {
				return nil, "", errInterrupted
			}
			return nil, "", setupErr("no Domain Scout backend answers at %s: %v", url, err)
		}
		if err := runtime.CheckProtocol(h); err != nil {
			return nil, "", setupErr("%v", err)
		}
		return &connection{url: url, health: h}, dataDir, nil
	}
	lc := a.launcherConfig(dataDir)
	info, h, err := lc.Discover(ctx)
	replacedPort := 0
	switch {
	case err == nil:
		conn := &connection{url: strings.TrimRight(info.URL, "/"), health: h}
		if !autostart {
			return conn, dataDir, nil
		}
		if next, startOwn := a.replaceOlderBackend(ctx, lc, conn, dataDir); !startOwn {
			return next, dataDir, nil
		}
		// The older backend stopped; start this version's below, on the port it used.
		replacedPort = urlPort(info.URL)
	case ctx.Err() != nil:
		return nil, "", errInterrupted
	case errors.Is(err, runtime.ErrUnreachable):
		if !autostart {
			return nil, dataDir, setupErr("the backend is not running for %s. Start it with 'domain-scout service start'.", dataDir)
		}
	case errors.Is(err, runtime.ErrIdentityMismatch), errors.Is(err, runtime.ErrNotBackend):
		return nil, "", setupErr("%v. Another process is using the recorded backend address; stop it or remove %s.", err, filepath.Join(runtime.RunDir(dataDir), "backend.json"))
	default:
		return nil, "", asSetup(err)
	}
	port, err := a.backendPort()
	if err != nil {
		return nil, "", err
	}
	if replacedPort > 0 {
		port = replacedPort
	}
	info, h, err = lc.StartBackend(ctx, port, a.webOrigins)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", errInterrupted
		}
		return nil, "", asSetup(err)
	}
	a.started = true
	return &connection{url: strings.TrimRight(info.URL, "/"), health: h}, dataDir, nil
}

// urlPort is the port of a backend URL such as http://127.0.0.1:4317, or 0.
func urlPort(raw string) int {
	u, err := url.Parse(raw)
	if err != nil {
		return 0
	}
	p, _ := strconv.Atoi(u.Port())
	return p
}

func asSetup(err error) error {
	var se *launcher.SetupError
	if errors.As(err, &se) {
		return setupErr("%s", se.Msg)
	}
	var e *exitError
	if errors.As(err, &e) {
		return e
	}
	return setupErr("%v", err)
}

// api returns an authenticated client for a verified (auto-started) backend.
func (a *App) api(ctx context.Context) (*apiClient, error) {
	if a.client != nil {
		return a.client, nil
	}
	conn, dataDir, err := a.connect(ctx, true)
	if err != nil {
		return nil, err
	}
	token, err := a.token(dataDir)
	if err != nil {
		return nil, err
	}
	a.client = newAPIClient(conn.url, token, conn.health.Response.Data.InstanceId.String(), a.opts.timeout, a.Version)
	if a.opts.backendURL == "" {
		a.client.revive = a.reviveBackend
	}
	return a.client, nil
}

func (a *App) token(dataDir string) (string, error) {
	if a.opts.backendURL != "" {
		if t := strings.TrimSpace(a.Getenv(EnvAPIToken)); t != "" {
			return t, nil
		}
	}
	t, err := runtime.ReadToken(dataDir)
	if err != nil {
		hint := ""
		if a.opts.backendURL != "" {
			hint = " or set " + EnvAPIToken
		}
		return "", setupErr("cannot read the API token in %s: %v. Check --data-dir%s.", runtime.RunDir(dataDir), err, hint)
	}
	return t, nil
}

func (a *App) pollInterval() time.Duration {
	if a.PollInterval > 0 {
		return a.PollInterval
	}
	return time.Second
}
