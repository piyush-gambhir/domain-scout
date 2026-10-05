package sse

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParserFields(t *testing.T) {
	in := ": comment line\r\n" +
		"retry: 1500\r\n" +
		"id: 1\r\n" +
		"event: job.updated\r\n" +
		"data: {\"a\":1,\r\n" +
		"data:  \"b\":2}\r\n" +
		"\r\n" +
		"id: 2\n" +
		"\n" + // id-only block: moves the cursor, dispatches nothing
		"id: 3\n" +
		"data: {\"type\":\"heartbeat\"}\n" +
		"\n" +
		"data: no-type\n" +
		"\n" +
		"id: 4\n" +
		"data: partial" // unterminated: must not dispatch
	p := NewParser(strings.NewReader(in))

	ev, err := p.Next()
	if err != nil {
		t.Fatal(err)
	}
	if ev.ID != "1" || ev.Type != "job.updated" || string(ev.Data) != "{\"a\":1,\n \"b\":2}" {
		t.Fatalf("first event wrong: %+v %q", ev, ev.Data)
	}
	if p.Retry() != 1500*time.Millisecond {
		t.Fatalf("retry %v", p.Retry())
	}
	ev, _ = p.Next()
	if ev.ID != "2" || !ev.CursorOnly || ev.Data != nil {
		t.Fatalf("id-only block should be a cursor record: %+v", ev)
	}
	ev, _ = p.Next()
	if ev.ID != "3" || ev.Type != TypeHeartbeat {
		t.Fatalf("type should come from JSON data: %+v", ev)
	}
	ev, _ = p.Next()
	if ev.ID != "" || ev.Type != "message" || string(ev.Data) != "no-type" {
		t.Fatalf("plain data event wrong: %+v", ev)
	}
	if _, err := p.Next(); err != io.EOF {
		t.Fatalf("partial final event must be dropped, got %v", err)
	}
}

// sseServer serves one scripted response per connection and records the
// Last-Event-ID each connection sent.
type sseServer struct {
	t       *testing.T
	mu      sync.Mutex
	cursors []string
	conns   []func(w http.ResponseWriter, flush func(), hold func(time.Duration))
	srv     *httptest.Server
}

func newSSEServer(t *testing.T, conns ...func(w http.ResponseWriter, flush func(), hold func(time.Duration))) *sseServer {
	s := &sseServer{t: t, conns: conns}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		n := len(s.cursors)
		s.cursors = append(s.cursors, r.Header.Get("Last-Event-ID"))
		s.mu.Unlock()
		if n >= len(s.conns) {
			http.Error(w, "no more scripted connections", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		fl := w.(http.Flusher)
		fl.Flush()
		// hold waits like time.Sleep but returns when the client disconnects,
		// so server shutdown is not delayed.
		hold := func(d time.Duration) {
			select {
			case <-r.Context().Done():
			case <-time.After(d):
			}
		}
		s.conns[n](w, fl.Flush, hold)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *sseServer) open(ctx context.Context, last string) (io.ReadCloser, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.srv.URL, nil)
	if last != "" {
		req.Header.Set("Last-Event-ID", last)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.Body, nil
}

func (s *sseServer) seenCursors() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.cursors...)
}

func event(w io.Writer, id, typ string) {
	fmt.Fprintf(w, "id: %s\nevent: %s\ndata: {\"eventId\":\"%s\",\"type\":\"%s\"}\n\n", id, typ, id, typ)
}

func quickBackoff(int) time.Duration { return time.Millisecond }

func TestStreamReplaysWithLastEventIDAndSuppressesDuplicates(t *testing.T) {
	srv := newSSEServer(t,
		func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
			event(w, "1", "job.progress")
			event(w, "2", "job.progress")
			event(w, "3", "job.progress")
			flush()
			// Connection drops here.
		},
		func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
			// The server replays from an older point; 2 and 3 are duplicates.
			event(w, "2", "job.progress")
			event(w, "3", "job.progress")
			event(w, "4", "job.updated")
			flush()
			hold(time.Second)
		},
	)
	var got []string
	s := &Stream{Open: srv.open, Backoff: quickBackoff}
	err := s.Run(context.Background(), Handlers{OnEvent: func(ev Event) (bool, error) {
		got = append(got, ev.ID)
		return ev.ID == "4", nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "1,2,3,4" {
		t.Fatalf("events delivered %v, want each once", got)
	}
	if c := srv.seenCursors(); len(c) != 2 || c[0] != "" || c[1] != "3" {
		t.Fatalf("Last-Event-ID per connection = %q, want [\"\" \"3\"]", c)
	}
	if s.LastEventID != "4" {
		t.Fatalf("cursor %q", s.LastEventID)
	}
}

func TestStreamResetRefetchesAndMovesCursor(t *testing.T) {
	srv := newSSEServer(t, func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
		event(w, "5", "job.progress")
		fmt.Fprint(w, "id: 10\nevent: stream.reset\ndata: {\"type\":\"stream.reset\",\"payload\":{\"reason\":\"expired\",\"oldestEventId\":\"9\"}}\n\n")
		event(w, "11", "job.updated")
		flush()
		hold(time.Second)
	})
	var events []string
	resets := 0
	s := &Stream{Open: srv.open, Backoff: quickBackoff}
	err := s.Run(context.Background(), Handlers{
		OnReset: func(ev Event) (bool, error) {
			resets++
			if ev.ID != "10" {
				t.Errorf("reset id %q", ev.ID)
			}
			return false, nil
		},
		OnEvent: func(ev Event) (bool, error) {
			events = append(events, ev.ID)
			return ev.ID == "11", nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if resets != 1 || strings.Join(events, ",") != "5,11" {
		t.Fatalf("resets=%d events=%v", resets, events)
	}
}

func TestStreamHeartbeatsKeepConnectionAlive(t *testing.T) {
	srv := newSSEServer(t, func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
		for i := 0; i < 6; i++ {
			if i%2 == 0 {
				fmt.Fprintf(w, "id: %d\nevent: heartbeat\ndata: {}\n\n", i+1)
			} else {
				fmt.Fprint(w, ": ping\n\n")
			}
			flush()
			time.Sleep(40 * time.Millisecond)
		}
		event(w, "100", "job.updated")
		flush()
		hold(time.Second)
	})
	var got []string
	s := &Stream{Open: srv.open, IdleTimeout: 150 * time.Millisecond, Backoff: quickBackoff}
	err := s.Run(context.Background(), Handlers{OnEvent: func(ev Event) (bool, error) {
		got = append(got, ev.Type)
		return true, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "job.updated" {
		t.Fatalf("heartbeats must not be delivered: %v", got)
	}
	if n := len(srv.seenCursors()); n != 1 {
		t.Fatalf("heartbeats should prevent idle reconnects, saw %d connections", n)
	}
}

func TestStreamIdleTimeoutReconnects(t *testing.T) {
	srv := newSSEServer(t,
		func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
			event(w, "1", "job.progress")
			flush()
			hold(2 * time.Second) // silent: no heartbeat
		},
		func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
			event(w, "2", "job.updated")
			flush()
			hold(time.Second)
		},
	)
	connects := 0
	s := &Stream{Open: srv.open, IdleTimeout: 100 * time.Millisecond, Backoff: quickBackoff}
	err := s.Run(context.Background(), Handlers{
		OnConnect: func() (bool, error) { connects++; return false, nil },
		OnEvent:   func(ev Event) (bool, error) { return ev.ID == "2", nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if c := srv.seenCursors(); len(c) != 2 || c[1] != "1" {
		t.Fatalf("expected a resumed second connection, cursors %q", c)
	}
	if connects != 2 {
		t.Fatalf("OnConnect should run per connection (refetch), ran %d", connects)
	}
}

func TestStreamUnsupportedAndUnavailable(t *testing.T) {
	s := &Stream{Open: func(context.Context, string) (io.ReadCloser, error) {
		return nil, fmt.Errorf("%w: HTTP 404", ErrUnsupported)
	}}
	if err := s.Run(context.Background(), Handlers{}); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("want ErrUnsupported, got %v", err)
	}
	attempts := 0
	s = &Stream{MaxFailures: 3, Backoff: quickBackoff, Open: func(context.Context, string) (io.ReadCloser, error) {
		attempts++
		return nil, errors.New("connection refused")
	}}
	if err := s.Run(context.Background(), Handlers{}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("want ErrUnavailable, got %v", err)
	}
	if attempts != 3 {
		t.Fatalf("attempts %d", attempts)
	}
}

func TestStreamContextCancelUnblocksRead(t *testing.T) {
	srv := newSSEServer(t, func(w http.ResponseWriter, flush func(), hold func(time.Duration)) { hold(3 * time.Second) })
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	start := time.Now()
	err := (&Stream{Open: srv.open}).Run(ctx, Handlers{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("cancel did not unblock the read")
	}
}

func TestDedupNonNumericIDs(t *testing.T) {
	var d dedup
	if d.duplicate("a") || d.duplicate("b") {
		t.Fatal("first sightings are not duplicates")
	}
	if !d.duplicate("a") {
		t.Fatal("repeat must be a duplicate")
	}
	var n dedup
	if n.duplicate("7") || !n.duplicate("7") || !n.duplicate("3") || n.duplicate("8") {
		t.Fatal("numeric ids use a high-water mark")
	}
}

func TestStreamCursorOnlyRecordsMoveAndClearCursor(t *testing.T) {
	srv := newSSEServer(t,
		func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
			event(w, "1", "job.progress")
			fmt.Fprint(w, "id: 5\n\n") // cursor only
			flush()
		},
		func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
			event(w, "6", "job.progress")
			fmt.Fprint(w, "id:\n\n") // empty id resets the cursor
			flush()
		},
		func(w http.ResponseWriter, flush func(), hold func(time.Duration)) {
			event(w, "7", "job.updated")
			flush()
			hold(time.Second)
		},
	)
	var got []string
	s := &Stream{Open: srv.open, Backoff: quickBackoff}
	err := s.Run(context.Background(), Handlers{OnEvent: func(ev Event) (bool, error) {
		got = append(got, ev.ID)
		return ev.ID == "7", nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "1,6,7" {
		t.Fatalf("cursor records must not dispatch: %v", got)
	}
	if c := srv.seenCursors(); strings.Join(c, "|") != "|5|" {
		t.Fatalf("cursors per connection %q, want [\"\" \"5\" \"\"]", c)
	}
}

func TestStreamPermanentErrorStopsImmediately(t *testing.T) {
	attempts := 0
	authErr := errors.New("HTTP 401")
	s := &Stream{Backoff: quickBackoff, Open: func(context.Context, string) (io.ReadCloser, error) {
		attempts++
		return nil, Permanent(authErr)
	}}
	if err := s.Run(context.Background(), Handlers{}); !errors.Is(err, authErr) || attempts != 1 {
		t.Fatalf("err %v after %d attempts", err, attempts)
	}
}
