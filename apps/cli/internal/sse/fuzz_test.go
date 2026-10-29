package sse

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// FuzzParser feeds arbitrary bytes to the parser: it never panics, ends with
// io.EOF, dispatches at most one event per line, never accepts an id with a
// NUL, and keeps the retry delay between zero and maxRetry.
// `go test -run=^$ -fuzz=FuzzParser ./internal/sse` explores further.
func FuzzParser(f *testing.F) {
	f.Add([]byte("id: 1\nevent: job.updated\ndata: {\"a\":1,\ndata:  \"b\":2}\n\n"))
	f.Add([]byte(": comment\r\nretry: 1500\r\nid: 2\r\n\r\n"))
	f.Add([]byte("data: {\"type\":\"heartbeat\"}\n\nid: 4\ndata: partial"))
	f.Add([]byte("id: a\x00b\ndata\n\nid\n\nretry: -5\nretry: x\n\n"))
	f.Fuzz(func(t *testing.T, stream []byte) {
		p := NewParser(bytes.NewReader(stream))
		lines := bytes.Count(stream, []byte("\n"))
		for events := 1; ; events++ {
			ev, err := p.Next()
			if err != nil {
				if err != io.EOF {
					t.Fatalf("stream ended with %v, want io.EOF", err)
				}
				break
			}
			if events > lines {
				t.Fatalf("%d events from %d lines", events, lines)
			}
			if strings.ContainsRune(ev.ID, 0) {
				t.Fatalf("accepted an id containing NUL: %q", ev.ID)
			}
			if ev.CursorOnly && (!ev.HasID || ev.Type != "" || ev.Data != nil) {
				t.Fatalf("cursor-only event carries more than an id: %+v", ev)
			}
			if !ev.CursorOnly && ev.Type == "" {
				t.Fatalf("dispatched event without a type: %+v", ev)
			}
		}
		if r := p.Retry(); r < 0 || r > maxRetry {
			t.Fatalf("retry delay %v outside [0, %v]", r, maxRetry)
		}
	})
}

// FuzzParserRoundTrip encodes one event the way a server would and checks the
// parser returns exactly it, then io.EOF.
func FuzzParserRoundTrip(f *testing.F) {
	f.Add("7", "job.updated", `{"jobId":"j1"}`)
	f.Add("", "message", "line one\nline two")
	f.Add(" spaced", " spaced", " spaced\n")
	f.Fuzz(func(t *testing.T, id, typ, data string) {
		if typ == "" || strings.ContainsAny(id+typ, "\r\n\x00") || strings.ContainsRune(data, '\r') {
			t.Skip("not representable as one event")
		}
		var b strings.Builder
		b.WriteString("id: " + id + "\nevent: " + typ + "\n")
		for _, line := range strings.Split(data, "\n") {
			b.WriteString("data: " + line + "\n")
		}
		b.WriteString("\n")
		p := NewParser(strings.NewReader(b.String()))
		ev, err := p.Next()
		if err != nil {
			t.Fatal(err)
		}
		if ev.ID != id || !ev.HasID || ev.Type != typ || string(ev.Data) != data || ev.CursorOnly {
			t.Fatalf("got %+v (data %q), want id %q type %q data %q", ev, ev.Data, id, typ, data)
		}
		if _, err := p.Next(); err != io.EOF {
			t.Fatalf("after the event: %v, want io.EOF", err)
		}
	})
}
