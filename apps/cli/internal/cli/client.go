package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
	"github.com/piyush-gambhir/domain-scout/cli/internal/sse"
)

func probeClient() *http.Client { return &http.Client{Timeout: 5 * time.Second} }

// apiClient wraps the generated client with auth, timeouts, error mapping
// and raw body access so JSON output stays verbatim.
type apiClient struct {
	base    string
	gen     *api.Client
	timeout time.Duration
}

// callFn invokes one generated client method.
type callFn func(ctx context.Context, g *api.Client) (*http.Response, error)

type response struct {
	status int
	header http.Header
	body   []byte
}

func newAPIClient(base, token string, timeout time.Duration, version string) *apiClient {
	// No client-wide timeout: event streams are long lived. Requests get a
	// per-call deadline; waiting for response headers (including a stream's)
	// is bounded separately so a silent backend cannot hang a wait.
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = timeout
	hc := &http.Client{Transport: tr}
	auth := func(ctx context.Context, req *http.Request) error {
		if !strings.HasSuffix(req.URL.Path, "/api/v1/health") {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("User-Agent", "domain-scout-cli/"+version)
		// Lets History tell agent (CLI) runs apart from searches started in the UI.
		req.Header.Set("X-Domain-Scout-Client", "cli")
		return nil
	}
	gen, _ := api.NewClient(base, api.WithHTTPClient(hc), api.WithRequestEditorFn(auth))
	return &apiClient{base: base, gen: gen, timeout: timeout}
}

func (c *apiClient) transportErr(parent, rctx context.Context, err error) error {
	if parent.Err() != nil {
		return errInterrupted
	}
	if errors.Is(rctx.Err(), context.DeadlineExceeded) {
		return failErr("the request to %s timed out after %s; raise --timeout", c.base, c.timeout)
	}
	e := setupErr("the backend at %s is unreachable: %v", c.base, err)
	e.(*exitError).retryable = true
	return e
}

// do performs one request and returns the body of a 2xx response or a typed
// error for anything else.
func (c *apiClient) do(ctx context.Context, fn callFn) (*response, error) {
	rctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := fn(rctx, c.gen)
	if err != nil {
		return nil, c.transportErr(ctx, rctx, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, c.transportErr(ctx, rctx, err)
	}
	if resp.StatusCode >= 400 {
		return nil, apiError(resp.StatusCode, body)
	}
	return &response{status: resp.StatusCode, header: resp.Header, body: body}, nil
}

// doIdempotent retries connection failures. Callers pass the same
// Idempotency-Key on every attempt so the backend never duplicates work.
func (c *apiClient) doIdempotent(ctx context.Context, fn callFn) (*response, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		res, err := c.do(ctx, fn)
		if err == nil {
			return res, nil
		}
		var e *exitError
		if !errors.As(err, &e) || !e.retryable {
			return nil, err
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return nil, errInterrupted
		case <-time.After(time.Duration(300*(attempt+1)) * time.Millisecond):
		}
	}
	return nil, lastErr
}

// download streams a 2xx body to w.
func (c *apiClient) download(ctx context.Context, fn callFn, w io.Writer) error {
	rctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := fn(rctx, c.gen)
	if err != nil {
		return c.transportErr(ctx, rctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return apiError(resp.StatusCode, body)
	}
	if _, err := io.Copy(w, resp.Body); err != nil {
		if ctx.Err() != nil {
			return errInterrupted
		}
		return failErr("download failed: %v", err)
	}
	return nil
}

// pageEnvelope is the paginated list envelope with items kept verbatim.
type pageEnvelope struct {
	ContractVersion string            `json:"contractVersion"`
	Data            []json.RawMessage `json:"data"`
	NextCursor      *string           `json:"nextCursor"`
	Total           *int              `json:"total"`
}

// all follows nextCursor until the end and returns one combined envelope.
func (c *apiClient) all(ctx context.Context, start *string, fn func(cursor *string) callFn) ([]byte, error) {
	combined := pageEnvelope{Data: []json.RawMessage{}}
	cursor := start
	for first := true; ; first = false {
		res, err := c.do(ctx, fn(cursor))
		if err != nil {
			return nil, err
		}
		var p pageEnvelope
		if err := json.Unmarshal(res.body, &p); err != nil {
			return nil, failErr("backend returned a malformed page: %v", err)
		}
		if first {
			combined.ContractVersion = p.ContractVersion
		}
		combined.Data = append(combined.Data, p.Data...)
		if p.NextCursor == nil || *p.NextCursor == "" || (cursor != nil && *p.NextCursor == *cursor) {
			break
		}
		cursor = p.NextCursor
	}
	total := len(combined.Data)
	combined.Total = &total
	return json.Marshal(combined)
}

func (c *apiClient) getJob(ctx context.Context, id api.Uuid) (*api.Job, []byte, error) {
	res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
		return g.GetJob(ctx, id)
	})
	if err != nil {
		return nil, nil, err
	}
	var jr api.JobResponse
	if err := json.Unmarshal(res.body, &jr); err != nil {
		return nil, nil, failErr("backend returned a malformed job: %v", err)
	}
	return &jr.Data, res.body, nil
}

// openEvents returns an sse.Stream opener for GET /events with params.
func (c *apiClient) openEvents(params api.StreamEventsParams) func(ctx context.Context, lastID string) (io.ReadCloser, error) {
	return func(ctx context.Context, lastID string) (io.ReadCloser, error) {
		resp, err := c.gen.StreamEvents(ctx, &params, func(ctx context.Context, req *http.Request) error {
			req.Header.Set("Accept", "text/event-stream")
			if lastID != "" {
				req.Header.Set("Last-Event-ID", lastID)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
			resp.Body.Close()
			switch {
			case resp.StatusCode == http.StatusNotFound, resp.StatusCode == http.StatusMethodNotAllowed,
				resp.StatusCode == http.StatusNotAcceptable, resp.StatusCode == http.StatusNotImplemented:
				// No stream here: callers fall back to polling.
				return nil, fmt.Errorf("%w: HTTP %d", sse.ErrUnsupported, resp.StatusCode)
			case resp.StatusCode < 500 && resp.StatusCode != http.StatusTooManyRequests:
				// Request or auth failures keep their ErrorResponse and exit code.
				return nil, sse.Permanent(apiError(resp.StatusCode, body))
			}
			return nil, fmt.Errorf("event stream returned HTTP %d", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
			resp.Body.Close()
			return nil, fmt.Errorf("%w: content type %q", sse.ErrUnsupported, ct)
		}
		return resp.Body, nil
	}
}

// newIdempotencyKey returns a random key reused across retries of one submission.
func newIdempotencyKey() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "cli-" + hex.EncodeToString(b[:])
}
