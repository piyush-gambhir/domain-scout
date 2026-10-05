package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

// BackendInfo mirrors <dataDir>/run/backend.json written by the backend.
type BackendInfo struct {
	URL             string `json:"url"`
	PID             int    `json:"pid"`
	InstanceID      string `json:"instanceId"`
	ProtocolVersion int    `json:"protocolVersion"`
	ContractVersion string `json:"contractVersion"`
	Version         string `json:"version"`
	StartedAt       string `json:"startedAt"`
	DataDir         string `json:"dataDir"`
}

// WebInfo mirrors <dataDir>/run/web.json, written by the launcher when it
// starts the UI server.
type WebInfo struct {
	URL string `json:"url"`
	PID int    `json:"pid"`
	// BackendURL is the backend the UI server forwards to (CLI extension;
	// absent in files written by other tools).
	BackendURL string `json:"backendUrl,omitempty"`
}

// RunDir is the transient runtime directory inside the data directory.
func RunDir(dataDir string) string { return filepath.Join(dataDir, "run") }

// LogDir holds backend and web server logs written by the launcher.
func LogDir(dataDir string) string { return filepath.Join(dataDir, "logs") }

// ReadBackendInfo reads backend.json. A missing file returns an error
// matching os.ErrNotExist.
func ReadBackendInfo(dataDir string) (*BackendInfo, error) {
	b, err := os.ReadFile(filepath.Join(RunDir(dataDir), "backend.json"))
	if err != nil {
		return nil, err
	}
	var info BackendInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return nil, fmt.Errorf("backend.json is not valid JSON: %w", err)
	}
	if info.URL == "" {
		return nil, errors.New("backend.json has no url")
	}
	return &info, nil
}

// ReadToken reads the owner-only API token file.
func ReadToken(dataDir string) (string, error) {
	b, err := os.ReadFile(filepath.Join(RunDir(dataDir), "api-token"))
	if err != nil {
		return "", err
	}
	tok := strings.TrimSpace(string(b))
	if tok == "" {
		return "", errors.New("api-token file is empty")
	}
	return tok, nil
}

// ReadWebInfo reads web.json.
func ReadWebInfo(dataDir string) (*WebInfo, error) {
	b, err := os.ReadFile(filepath.Join(RunDir(dataDir), "web.json"))
	if err != nil {
		return nil, err
	}
	var info WebInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

// WriteWebInfo writes web.json with owner-only permissions.
func WriteWebInfo(dataDir string, info WebInfo) error {
	dir := RunDir(dataDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(info)
	tmp := filepath.Join(dir, "web.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "web.json"))
}

// RemoveWebInfo deletes web.json if present.
func RemoveWebInfo(dataDir string) {
	_ = os.Remove(filepath.Join(RunDir(dataDir), "web.json"))
}

// Errors returned by health verification.
var (
	// ErrUnreachable means nothing answered at the URL (stale runtime file or stopped backend).
	ErrUnreachable = errors.New("backend unreachable")
	// ErrNotBackend means something answered but it is not a Domain Scout backend.
	ErrNotBackend = errors.New("not a Domain Scout backend")
	// ErrIdentityMismatch means a backend answered with a different instance id.
	ErrIdentityMismatch = errors.New("backend identity mismatch")
	// ErrProtocolMismatch means the backend speaks an unsupported runtime protocol.
	ErrProtocolMismatch = errors.New("backend protocol version mismatch")
)

// Health is the verified health response plus its verbatim body.
type Health struct {
	Response api.HealthResponse
	Raw      []byte
}

// FetchHealth calls GET /api/v1/health (no auth) and decodes it.
func FetchHealth(ctx context.Context, hc *http.Client, baseURL string) (*Health, error) {
	req, err := api.NewGetHealthRequest(strings.TrimRight(baseURL, "/"))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNotBackend, err)
	}
	resp, err := hc.Do(req.WithContext(ctx))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: health returned HTTP %d", ErrNotBackend, resp.StatusCode)
	}
	var h api.HealthResponse
	if err := json.Unmarshal(body, &h); err != nil || h.Data.Status != "ok" {
		return nil, fmt.Errorf("%w: unexpected health response", ErrNotBackend)
	}
	return &Health{Response: h, Raw: body}, nil
}

// Verify checks that the backend described by info answers with the same
// instance id and a supported protocol version. Clients must verify before
// reusing a backend, not just trust an answering port.
func Verify(ctx context.Context, hc *http.Client, info *BackendInfo) (*Health, error) {
	h, err := FetchHealth(ctx, hc, info.URL)
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(h.Response.Data.InstanceId.String(), info.InstanceID) {
		return nil, fmt.Errorf("%w: %s answered as instance %s, runtime file expects %s",
			ErrIdentityMismatch, info.URL, h.Response.Data.InstanceId, info.InstanceID)
	}
	if err := CheckProtocol(h); err != nil {
		return nil, err
	}
	return h, nil
}

// CheckProtocol rejects a backend speaking another runtime protocol version.
func CheckProtocol(h *Health) error {
	if h.Response.Data.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("%w: backend speaks protocol %d, this CLI speaks %d; install matching versions",
			ErrProtocolMismatch, h.Response.Data.ProtocolVersion, ProtocolVersion)
	}
	return nil
}
