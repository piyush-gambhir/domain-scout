package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
	"github.com/piyush-gambhir/domain-scout/cli/internal/sse"
)

func probeClient() *http.Client { return &http.Client{Timeout: 5 * time.Second} }

// apiClient wraps the generated client with auth, timeouts, error mapping
// and raw body access so JSON output stays verbatim. It is safe for
// concurrent use (MCP tool calls).
type apiClient struct {
	timeout time.Duration
	hc      *http.Client
	version string
	// revive replaces a backend that stopped (idle) or is stopping; nil with
	// --backend-url. It returns the new backend's URL, token and instance id.
	revive   func(ctx context.Context, gone string) (base, token, instance string, err error)
	reviveMu sync.Mutex

	mu       sync.RWMutex
	base     string
	token    string
	instance string
	gen      *api.Client
	epoch    int // bumped by every revive
}

// callFn invokes one generated client method.
type callFn func(ctx context.Context, g *api.Client) (*http.Response, error)

type response struct {
	status int
	header http.Header
	body   []byte
}

func newAPIClient(base, token, instance string, timeout time.Duration, version string) *apiClient {
	// No client-wide timeout: event streams are long lived. Requests get a
	// per-call deadline; waiting for response headers (including a stream's)
	// is bounded separately so a silent backend cannot hang a wait.
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = timeout
	c := &apiClient{timeout: timeout, hc: &http.Client{Transport: tr}, version: version, base: base, token: token, instance: instance}
	c.gen = c.newGen(base)
	return c
}

func (c *apiClient) newGen(base string) *api.Client {
	auth := func(ctx context.Context, req *http.Request) error {
		if !strings.HasSuffix(req.URL.Path, "/api/v1/health") {
			c.mu.RLock()
			req.Header.Set("Authorization", "Bearer "+c.token)
			c.mu.RUnlock()
		}
		req.Header.Set("User-Agent", "domain-scout-cli/"+c.version)
		// Lets History tell agent (CLI) runs apart from searches started in the UI.
		req.Header.Set("X-Domain-Scout-Client", "cli")
		return nil
	}
	gen, _ := api.NewClient(base, api.WithHTTPClient(c.hc), api.WithRequestEditorFn(auth))
	return gen
}

// current returns the generated client and its revive epoch.
func (c *apiClient) current() (*api.Client, int) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.gen, c.epoch
}

// baseURL is the backend URL currently in use.
func (c *apiClient) baseURL() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.base
}

// reconnect revives the backend once per failure: callers that failed on an
// epoch another call has already revived simply retry.
func (c *apiClient) reconnect(ctx context.Context, failed int) error {
	c.reviveMu.Lock()
	defer c.reviveMu.Unlock()
	c.mu.RLock()
	epoch, gone := c.epoch, c.instance
	c.mu.RUnlock()
	if epoch != failed {
		return nil
	}
	base, token, instance, err := c.revive(ctx, gone)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.base, c.token, c.instance = base, token, instance
	c.gen = c.newGen(base)
	c.epoch++
	return nil
}

// backendGone reports a request the backend never handled because it had
// stopped (nothing listening) or was stopping, so a retry cannot repeat work.
func backendGone(err error) bool {
	var e *exitError
	return errors.As(err, &e) && e.gone
}

// stoppingMessage is the backend's refusal while it stops (AuthGuard and the jobs engine).
const stoppingMessage = "The backend is stopping"

func isDialError(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial"
}

func (c *apiClient) transportErr(parent, rctx context.Context, err error) error {
	if parent.Err() != nil {
		return errInterrupted
	}
	if errors.Is(rctx.Err(), context.DeadlineExceeded) {
		return failErr("the request to %s timed out after %s; raise --timeout", c.baseURL(), c.timeout)
	}
	e := setupErr("the backend at %s is unreachable: %v", c.baseURL(), err).(*exitError)
	e.retryable = true
	e.gone = isDialError(err)
	return e
}

// do performs one request and returns the body of a 2xx response or a typed
// error for anything else. A backend that stopped itself when idle (or is
// stopping) is replaced and the request sent once more.
func (c *apiClient) do(ctx context.Context, fn callFn) (*response, error) {
	gen, epoch := c.current()
	res, err := c.doOnce(ctx, gen, fn)
	if err == nil || c.revive == nil || !backendGone(err) {
		return res, err
	}
	if rerr := c.reconnect(ctx, epoch); rerr != nil {
		return nil, rerr
	}
	gen, _ = c.current()
	return c.doOnce(ctx, gen, fn)
}

func (c *apiClient) doOnce(ctx context.Context, gen *api.Client, fn callFn) (*response, error) {
	rctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	resp, err := fn(rctx, gen)
	if err != nil {
		return nil, c.transportErr(ctx, rctx, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, c.transportErr(ctx, rctx, err)
	}
	if resp.StatusCode >= 400 {
		e := apiError(resp.StatusCode, body)
		if x, ok := e.(*exitError); ok && x.errCode == api.ErrorCodeUnavailable && x.msg == stoppingMessage {
			x.gone = true
		}
		return nil, e
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
	gen, _ := c.current()
	resp, err := fn(rctx, gen)
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
		gen, _ := c.current()
		resp, err := gen.StreamEvents(ctx, &params, func(ctx context.Context, req *http.Request) error {
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
