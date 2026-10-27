package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	goruntime "runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
	"github.com/piyush-gambhir/domain-scout/cli/internal/launcher"
	"github.com/piyush-gambhir/domain-scout/cli/internal/runtime"
)

func (a *App) versionCmd() *cobra.Command {
	return a.newCmd("version", "Print the CLI version and the contract it speaks", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			type info struct {
				Version         string `json:"version"`
				ContractVersion string `json:"contractVersion"`
				ProtocolVersion int    `json:"protocolVersion"`
				OS              string `json:"os"`
				Arch            string `json:"arch"`
			}
			body, _ := json.Marshal(struct {
				ContractVersion string `json:"contractVersion"`
				Data            info   `json:"data"`
			}{ContractVersion, info{a.Version, ContractVersion, runtime.ProtocolVersion, goruntime.GOOS, goruntime.GOARCH}})
			return a.emit(body, plainView)
		})
}

func (a *App) serviceCmd() *cobra.Command {
	var port int
	start := a.newCmd("start", "Start the local backend, or reuse a verified running one", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if a.opts.backendURL != "" {
				return usageErr("service start manages the local backend; it cannot be combined with --backend-url")
			}
			if !cmd.Flags().Changed("port") {
				p, err := a.backendPort()
				if err != nil {
					return err
				}
				port = p
			} else if port <= 0 || port > 65535 {
				return usageErr("--port must be between 1 and 65535")
			}
			dataDir, err := a.dataDir()
			if err != nil {
				return err
			}
			lc := a.launcherConfig(dataDir)
			_, h, err := lc.Discover(ctx)
			if err == nil {
				a.progress("The backend is already running at %s.", h.Response.Data.DataDir)
				return a.emit(h.Raw, plainView)
			}
			if !errors.Is(err, runtime.ErrUnreachable) {
				if ctx.Err() != nil {
					return errInterrupted
				}
				return asSetup(err)
			}
			_, h, err = lc.StartBackend(ctx, port, nil)
			if err != nil {
				if ctx.Err() != nil {
					return errInterrupted
				}
				return asSetup(err)
			}
			return a.emit(h.Raw, plainView)
		})
	start.Flags().IntVar(&port, "port", launcher.DefaultPort, "loopback port for the backend (default "+launcher.EnvPort+" or 4317)")

	status := a.newCmd("status", "Show the verified backend identity (exit 5 when not running)", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			conn, _, err := a.connect(ctx, false)
			if err != nil {
				return err
			}
			return a.emit(conn.health.Raw, plainView)
		})

	stop := a.newCmd("stop", "Gracefully stop the backend (jobs become interrupted and can be resumed)", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			conn, dataDir, err := a.connect(ctx, false)
			if err != nil {
				var e *exitError
				if errors.As(err, &e) && e.code == ExitSetup && dataDir != "" && a.opts.backendURL == "" {
					// Nothing verified is running for this data directory.
					a.progress("The backend is not running.")
					return nil
				}
				return err
			}
			token, err := a.token(dataDir)
			if err != nil {
				return err
			}
			c := newAPIClient(conn.url, token, conn.health.Response.Data.InstanceId.String(), a.opts.timeout, a.Version)
			res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.StopService(ctx)
			})
			if err != nil {
				return err
			}
			pid := conn.health.Response.Data.Pid
			a.progress("Stopping the backend (pid %d).", pid)
			if err := a.waitStopped(ctx, conn.url, pid); err != nil {
				return err
			}
			return a.emit(res.body, plainView)
		})

	return group("service", "Manage the local backend process", start, status, stop)
}

// waitStopped waits until the backend stops answering and its process exits.
func (a *App) waitStopped(ctx context.Context, baseURL string, pid int) error {
	deadline := time.Now().Add(a.opts.timeout)
	for {
		_, err := runtime.FetchHealth(ctx, probeClient(), baseURL)
		down := err != nil && errors.Is(err, runtime.ErrUnreachable)
		if down && (pid <= 0 || !launcher.ProcessAlive(pid)) {
			return nil
		}
		if time.Now().After(deadline) {
			return failErr("the backend did not stop within %s", a.opts.timeout)
		}
		select {
		case <-ctx.Done():
			return errInterrupted
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func (a *App) uiCmd() *cobra.Command {
	var noOpen bool
	var webPort int
	var jobID string
	cmd := a.newCmd("ui", "Open the web UI (starts the backend and UI server when needed)", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			if a.opts.backendURL != "" {
				return usageErr("ui manages local servers; it cannot be combined with --backend-url")
			}
			if webPort <= 0 || webPort > 65535 {
				return usageErr("--web-port must be a port number")
			}
			if webPort != launcher.DefaultWebPort {
				// The backend only accepts browser requests from known UI origins.
				a.webOrigins = []string{fmt.Sprintf("http://127.0.0.1:%d", webPort), fmt.Sprintf("http://localhost:%d", webPort)}
			}
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			if a.webOrigins != nil && !a.started {
				a.progress("The running backend was started for the default UI port; if the UI rejects requests, run 'domain-scout service stop' and retry 'domain-scout ui --web-port %d'.", webPort)
			}
			dataDir, err := a.dataDir()
			if err != nil {
				return err
			}
			webURL, err := a.launcherConfig(dataDir).EnsureWeb(ctx, c.baseURL(), webPort)
			if err != nil {
				if ctx.Err() != nil {
					return errInterrupted
				}
				return asSetup(err)
			}
			res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateBootstrapCode(ctx)
			})
			if err != nil {
				return err
			}
			var bc api.BootstrapCodeResponse
			if err := json.Unmarshal(res.body, &bc); err != nil || bc.Data.Code == "" {
				return failErr("the backend returned no bootstrap code")
			}
			link := webURL + "/auth/bootstrap?code=" + url.QueryEscape(bc.Data.Code)
			if jobID != "" {
				// After sign-in the UI opens this search's results instead of an empty search.
				link += "&next=" + url.QueryEscape("/search/"+jobID)
			}
			if noOpen {
				// The link is single use and expires quickly; it goes to stderr, never stdout.
				fmt.Fprintln(a.Stderr, link)
				return nil
			}
			open := a.OpenURL
			if open == nil {
				open = func(u string) error { return launcher.OpenBrowser(a.GOOS, u) }
			}
			if err := open(link); err != nil {
				fmt.Fprintf(a.Stderr, "Could not open a browser (%v). Open this link within 60 seconds:\n%s\n", err, link)
				return nil
			}
			a.progress("Opened %s. Closing the browser does not stop the backend; use 'domain-scout service stop'.", webURL)
			return nil
		})
	cmd.Flags().BoolVar(&noOpen, "no-open", false, "print the sign-in link to stderr instead of opening a browser")
	cmd.Flags().IntVar(&webPort, "web-port", launcher.DefaultWebPort, "loopback port for the UI server")
	cmd.Flags().StringVar(&jobID, "job", "", "open the results of this job id after sign-in")
	return cmd
}
