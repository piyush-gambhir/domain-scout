// Package sse reads the backend's server-sent event stream with replay
// (Last-Event-ID), heartbeat-aware idle detection, stream.reset handling,
// duplicate suppression and reconnection.
package sse

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Event types with stream-level meaning.
const (
	TypeHeartbeat = "heartbeat"
	TypeReset     = "stream.reset"
)

// Event is one dispatched server-sent event.
type Event struct {
	ID    string
	HasID bool   // the block had an id field; an empty ID then clears the cursor
	Type  string // `event:` field, else the JSON `type` in data, else "message"
	Data  []byte
	// CursorOnly marks a block with an id field but no data: it moves the
	// replay cursor without dispatching an event (SSE dispatch step 1).
	CursorOnly bool
}

// Parser reads events from an SSE byte stream.
type Parser struct {
	r     *bufio.Reader
	retry time.Duration
}

// NewParser wraps r.
func NewParser(r io.Reader) *Parser {
	return &Parser{r: bufio.NewReaderSize(r, 64*1024)}
}

// Retry returns the last `retry:` value sent by the server, or zero.
func (p *Parser) Retry() time.Duration { return p.retry }

// Next returns the next event. Comment lines (": ...") are skipped. A partial
// event at end of stream is discarded, as the SSE specification requires.
func (p *Parser) Next() (Event, error) {
	var (
		ev      Event
		data    bytes.Buffer
		hasData bool
	)
	for {
		line, err := p.r.ReadString('\n')
		if err != nil {
			// io.EOF here means the stream ended, possibly mid-event; a
			// partial event is never dispatched.
			return Event{}, err
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			if !hasData {
				if ev.HasID {
					return Event{ID: ev.ID, HasID: true, CursorOnly: true}, nil
				}
				ev = Event{}
				continue
			}
			ev.Data = bytes.TrimSuffix(data.Bytes(), []byte("\n"))
			if ev.Type == "" {
				ev.Type = typeFromData(ev.Data)
			}
			return ev, nil
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if found {
			value = strings.TrimPrefix(value, " ")
		}
		switch field {
		case "id":
			if !strings.ContainsRune(value, 0) {
				ev.ID, ev.HasID = value, true
			}
		case "event":
			ev.Type = value
		case "data":
			data.WriteString(value)
			data.WriteByte('\n')
			hasData = true
		case "retry":
			if ms, err := strconv.Atoi(value); err == nil && ms >= 0 {
				p.retry = time.Duration(ms) * time.Millisecond
			}
		}
	}
}

func typeFromData(data []byte) string {
	var probe struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &probe) == nil && probe.Type != "" {
		return probe.Type
	}
	return "message"
}

// Errors returned by Stream.Run.
var (
	// ErrUnsupported means the server does not offer the stream; fall back to polling.
	ErrUnsupported = errors.New("event stream not supported")
	// ErrUnavailable means repeated connection attempts failed; fall back to polling.
	ErrUnavailable = errors.New("event stream unavailable")
)

type permanentError struct{ err error }

func (p *permanentError) Error() string { return p.err.Error() }
func (p *permanentError) Unwrap() error { return p.err }

// Permanent marks an Open error that must end Run immediately (for example
// an authorization failure) instead of being retried.
func Permanent(err error) error { return &permanentError{err: err} }

// Handlers receive stream callbacks. Returning stop=true ends Run with nil.
type Handlers struct {
	// OnConnect runs after every successful (re)connection, before events are
	// read. Callers refetch state here so nothing between polls is missed.
	OnConnect func() (stop bool, err error)
	// OnEvent receives each new non-heartbeat, non-reset event once.
	OnEvent func(Event) (stop bool, err error)
	// OnReset runs when the server reports the replay cursor expired; callers
	// must refetch state.
	OnReset func(Event) (stop bool, err error)
}

// Stream keeps an event subscription alive across disconnects.
type Stream struct {
	// Open connects with the given Last-Event-ID ("" for none). Return an
	// error wrapping ErrUnsupported when the server cannot stream at all.
	Open func(ctx context.Context, lastEventID string) (io.ReadCloser, error)
	// LastEventID is the resume cursor; Run updates it as events arrive.
	LastEventID string
	// IdleTimeout reconnects when nothing, not even a heartbeat, arrives for
	// this long. Zero disables it.
	IdleTimeout time.Duration
	// MaxFailures is the number of consecutive failed connections before Run
	// returns ErrUnavailable. Zero means 5.
	MaxFailures int
	// Backoff returns the delay before reconnect attempt n (1-based).
	Backoff func(n int) time.Duration

	seen dedup
}

// DefaultBackoff doubles from 250ms up to 5s.
func DefaultBackoff(n int) time.Duration {
	d := 250 * time.Millisecond
	for i := 1; i < n && d < 5*time.Second; i++ {
		d *= 2
	}
	if d > 5*time.Second {
		d = 5 * time.Second
	}
	return d
}

// Run reads events until a handler stops, the context ends or the stream
// becomes unavailable.
func (s *Stream) Run(ctx context.Context, h Handlers) error {
	maxFailures := s.MaxFailures
	if maxFailures <= 0 {
		maxFailures = 5
	}
	backoff := s.Backoff
	if backoff == nil {
		backoff = DefaultBackoff
	}
	failures := 0
	var serverRetry time.Duration
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		body, err := s.Open(ctx, s.LastEventID)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			var perm *permanentError
			if errors.Is(err, ErrUnsupported) || errors.As(err, &perm) {
				return err
			}
			failures++
			if failures >= maxFailures {
				return errors.Join(ErrUnavailable, err)
			}
			if err := sleep(ctx, pickDelay(serverRetry, backoff(failures))); err != nil {
				return err
			}
			continue
		}
		if h.OnConnect != nil {
			stop, err := h.OnConnect()
			if err != nil || stop {
				body.Close()
				return err
			}
		}
		delivered, retry, stop, err := s.consume(ctx, body, h)
		body.Close()
		if retry > 0 {
			serverRetry = retry
		}
		if err != nil || stop {
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if delivered {
			failures = 0
		} else {
			failures++
			if failures >= maxFailures {
				return ErrUnavailable
			}
		}
		if err := sleep(ctx, pickDelay(serverRetry, backoff(max(failures, 1)))); err != nil {
			return err
		}
	}
}

func pickDelay(server, fallback time.Duration) time.Duration {
	if server > 0 {
		return server
	}
	return fallback
}

// consume reads one connection. delivered reports whether any bytes arrived,
// which resets the failure count.
func (s *Stream) consume(ctx context.Context, body io.ReadCloser, h Handlers) (delivered bool, retry time.Duration, stop bool, err error) {
	ar := &activityReader{r: body}
	if s.IdleTimeout > 0 {
		timer := time.AfterFunc(s.IdleTimeout, func() { body.Close() })
		defer timer.Stop()
		ar.onRead = func() { timer.Reset(s.IdleTimeout) }
	}
	// Close the body when the context ends so a blocked read returns.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			body.Close()
		case <-done:
		}
	}()

	p := NewParser(ar)
	for {
		ev, perr := p.Next()
		retry = p.Retry()
		if perr != nil {
			// EOF, idle timeout or a dropped connection: reconnect.
			return ar.any(), retry, false, nil
		}
		if ev.HasID {
			switch {
			case ev.ID == "":
				s.LastEventID = "" // an empty id field resets the cursor
			case s.seen.duplicate(ev.ID):
				continue
			default:
				s.LastEventID = ev.ID
			}
		}
		if ev.CursorOnly {
			continue
		}
		switch ev.Type {
		case TypeHeartbeat:
			continue
		case TypeReset:
			// The cursor expired. Continue from the reset event (or from now)
			// and let the caller refetch authoritative state.
			s.LastEventID = ev.ID
			if h.OnReset != nil {
				stop, err := h.OnReset(ev)
				if err != nil || stop {
					return true, retry, stop, err
				}
			}
		default:
			if h.OnEvent != nil {
				stop, err := h.OnEvent(ev)
				if err != nil || stop {
					return true, retry, stop, err
				}
			}
		}
	}
}

type activityReader struct {
	r      io.Reader
	onRead func()
	mu     sync.Mutex
	n      int64
}

func (a *activityReader) Read(p []byte) (int, error) {
	n, err := a.r.Read(p)
	if n > 0 {
		a.mu.Lock()
		a.n += int64(n)
		a.mu.Unlock()
		if a.onRead != nil {
			a.onRead()
		}
	}
	return n, err
}

func (a *activityReader) any() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.n > 0
}

// dedup suppresses replayed events. Numeric ids (the backend's monotonic
// cursor) use a high-water mark; other ids use a bounded set.
type dedup struct {
	high    uint64
	hasHigh bool
	set     map[string]struct{}
	order   []string
}

const dedupLimit = 10000

func (d *dedup) duplicate(id string) bool {
	if n, err := strconv.ParseUint(id, 10, 64); err == nil {
		if d.hasHigh && n <= d.high {
			return true
		}
		d.high, d.hasHigh = n, true
		return false
	}
	if d.set == nil {
		d.set = map[string]struct{}{}
	}
	if _, ok := d.set[id]; ok {
		return true
	}
	d.set[id] = struct{}{}
	d.order = append(d.order, id)
	if len(d.order) > dedupLimit {
		delete(d.set, d.order[0])
		d.order = d.order[1:]
	}
	return false
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
