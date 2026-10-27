package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
	"github.com/piyush-gambhir/domain-scout/cli/internal/launcher"
	"github.com/piyush-gambhir/domain-scout/cli/internal/runtime"
)

// reviveTimeout bounds waiting for a stopping backend to exit: its stop grace
// period plus the close timeout, with margin.
const reviveTimeout = 30 * time.Second

// reviveBackend replaces a backend that stopped itself when idle, or is
// stopping, so a command racing the stop or a long-lived MCP session carries
// on. It waits until the backend with instance id gone no longer answers,
// then starts (or finds) another one.
func (a *App) reviveBackend(ctx context.Context, gone string) (base, token, instance string, err error) {
	deadline := time.Now().Add(reviveTimeout)
	for {
		conn, dataDir, cerr := a.connect(ctx, true)
		if cerr == nil {
			if id := conn.health.Response.Data.InstanceId.String(); !strings.EqualFold(id, gone) {
				t, terr := a.token(dataDir)
				if terr != nil {
					return "", "", "", terr
				}
				return conn.url, t, id, nil
			}
		}
		if ctx.Err() != nil {
			return "", "", "", errInterrupted
		}
		if time.Now().After(deadline) {
			if cerr != nil {
				return "", "", "", cerr
			}
			return "", "", "", setupErr("the backend at %s is still stopping after %s. Run 'domain-scout service status' and retry.", conn.url, reviveTimeout)
		}
		select {
		case <-ctx.Done():
			return "", "", "", errInterrupted
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// replaceOlderBackend stops a running backend older than this CLI (after an
// upgrade) so this version's starts, unless that would lose work. It returns
// the connection to keep using, or startOwn when the old backend stopped and
// the caller should start this version's. A newer backend is never replaced,
// and nothing is stopped unless this CLI can start its replacement.
func (a *App) replaceOlderBackend(ctx context.Context, lc *launcher.Config, conn *connection, dataDir string) (next *connection, startOwn bool) {
	running := conn.health.Response.Data.Version
	cmp, ok := compareVersions(a.Version, running)
	if !ok || cmp == 0 {
		return conn, false
	}
	if cmp < 0 {
		a.progress("The running backend is version %s, newer than this CLI (%s). Upgrade the CLI if a command is missing.", running, a.Version)
		return conn, false
	}
	if _, err := lc.FindBackendEntry(); err != nil {
		return conn, false
	}
	if _, err := lc.FindNode(ctx); err != nil {
		return conn, false
	}
	token, err := a.token(dataDir)
	if err != nil {
		return conn, false
	}
	instance := conn.health.Response.Data.InstanceId.String()
	status, msg, err := stopUnlessBusy(ctx, conn.url, token, instance)
	switch {
	case err != nil:
		a.progress("Could not restart the backend (version %s) for this CLI (%s): %v", running, a.Version, err)
		return conn, false
	case status == http.StatusNotFound:
		// Backends without this route stop unconditionally, so a running one is never replaced.
		a.progress("The backend (version %s) cannot be replaced safely while it runs. Run 'domain-scout service stop' to switch to version %s.", running, a.Version)
		return conn, false
	case status == http.StatusConflict:
		a.progress("The backend (version %s) keeps running for now: %s. Version %s starts once it is idle, or after 'domain-scout service stop'.", running, strings.TrimSuffix(msg, "."), a.Version)
		return conn, false
	case status != http.StatusAccepted:
		a.progress("Could not restart the backend (version %s): HTTP %d %s", running, status, msg)
		return conn, false
	}
	a.progress("Restarting the backend: version %s was running, this CLI is %s.", running, a.Version)
	deadline := time.Now().Add(reviveTimeout)
	for time.Now().Before(deadline) {
		info, h, err := lc.Discover(ctx)
		switch {
		case errors.Is(err, runtime.ErrUnreachable):
			return nil, true
		case err == nil && !strings.EqualFold(h.Response.Data.InstanceId.String(), instance):
			// Another CLI already started the replacement.
			return &connection{url: strings.TrimRight(info.URL, "/"), health: h}, false
		}
		select {
		case <-ctx.Done():
			return conn, false
		case <-time.After(100 * time.Millisecond):
		}
	}
	// Starting now reports a clear "port in use" error if it never exited.
	return nil, true
}

// stopUnlessBusy calls POST /service/stop-unless-busy for the verified
// instance and returns the status with the error message, if any.
func stopUnlessBusy(ctx context.Context, base, token, instance string) (int, string, error) {
	body, _ := json.Marshal(map[string]string{"instanceId": instance})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/api/v1/service/stop-unless-busy", bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Domain-Scout-Client", "cli")
	resp, err := probeClient().Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	var e api.ErrorResponse
	if resp.StatusCode >= 400 && json.Unmarshal(raw, &e) == nil {
		return resp.StatusCode, e.Error.Message, nil
	}
	return resp.StatusCode, "", nil
}

var versionRe = regexp.MustCompile(`^v?(\d+)\.(\d+)\.(\d+)`)

// compareVersions compares release versions such as 0.2.0 (prerelease and
// build suffixes are ignored). ok is false when either is not a release
// version, e.g. a development build ("dev").
func compareVersions(a, b string) (cmp int, ok bool) {
	pa, oka := parseVersion(a)
	pb, okb := parseVersion(b)
	if !oka || !okb {
		return 0, false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			if pa[i] < pb[i] {
				return -1, true
			}
			return 1, true
		}
	}
	return 0, true
}

func parseVersion(s string) ([3]int, bool) {
	m := versionRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return [3]int{}, false
	}
	var v [3]int
	for i := range v {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v, true
}
