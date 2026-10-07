package cli

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestCancelledWaitMachineOutput(t *testing.T) {
	for _, output := range []string{"json", "ndjson"} {
		t.Run(output, func(t *testing.T) {
			f := newFakeAPI(t)
			cancelled := jobJSON(jobSpec{state: "cancelled", total: 2, finished: 1, outcomes: `{"no_record":1}`, seq: 2})
			finished := itemJSON("example.com", "no_record", true)
			f.reply("POST", "/api/v1/jobs", 201, envelope(jobJSON(jobSpec{state: "queued", total: 2})))
			f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{state: "running", total: 2})))
			f.on("GET", "/api/v1/events", sseHandler(
				sseEvent("2", "job.updated", jobID, cancelled),
			))
			f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, page([]string{finished}, ""))

			r := newHarness(t).api(f, "scan", "example.com", "google.com", "--wait", "--output", output)
			expectCode(t, r, ExitUnresolved) // Backend cancellation is exit 3, not an interrupted wait (130).
			for _, note := range []string{"Submitted job " + jobID, "cancelled: 1/2 finished", "ended cancelled with 1 unfinished"} {
				if !strings.Contains(r.stderr, note) {
					t.Errorf("stderr missing %q: %s", note, r.stderr)
				}
				if strings.Contains(r.stdout, note) {
					t.Errorf("diagnostic leaked to stdout: %q", note)
				}
			}

			if output == "ndjson" {
				lines := strings.Split(strings.TrimSuffix(r.stdout, "\n"), "\n")
				if len(lines) != 1 {
					t.Fatalf("want one completed result line, got %q", r.stdout)
				}
				row := decodeJSON(t, lines[0])
				if row["contractVersion"] != "1.0.0" {
					t.Fatalf("NDJSON row missing contractVersion: %s", lines[0])
				}
				delete(row, "contractVersion")
				if !reflect.DeepEqual(row, decodeJSON(t, finished)) {
					t.Fatalf("completed result changed: %#v", row)
				}
				return
			}

			// --wait prints the results envelope; the job's terminal state is on stderr and in the exit code.
			out := decodeJSON(t, r.stdout)
			data, ok := out["data"].([]any)
			if out["contractVersion"] != "1.0.0" || !ok || len(data) != 1 || !reflect.DeepEqual(data[0], decodeJSON(t, finished)) {
				t.Fatalf("JSON envelope lost the completed result: %s", r.stdout)
			}
		})
	}
}

func TestQuoteWaitPreservesDecisionFields(t *testing.T) {
	f := newFakeAPI(t)
	// Synthetic contract-shaped quote, not a live provider response.
	offer := decodeJSON(t, `{
		"id":"55555555-5555-4555-8555-555555555555","providerId":"porkbun",
		"domain":"example.com","suffix":"com","purchasePath":"new_registration","kind":"exact_quote",
		"currency":"USD","region":"US","registration":{"amount":"249.90","years":2},"minYears":2,
		"renewal":{"amount":"199.95","years":1},"transfer":{"amount":null,"includesYears":null},
		"fees":{"icann":"0.20","other":[{"label":"Processing","amount":"1.25"}],"tax":"excluded"},
		"premium":{"status":"confirmed","registration":"249.90","renewal":"199.95"},
		"promotion":{"description":"Two-year promotion","requiresTermYears":2,"restrictions":"New customers only",
			"expiresAt":"2026-10-08T10:00:00.000Z","eligibilityVerified":false},
		"observedAt":"2026-10-07T10:00:00.000Z","publishedAt":null,
		"quoteExpiresAt":"2026-10-07T10:10:00.000Z","staleAt":"2026-10-07T10:10:00.000Z","freshness":"fresh",
		"source":{"label":"Porkbun exact-name quote","url":"https://porkbun.com/api/json/v3/documentation"},
		"destination":{"url":"https://porkbun.com/checkout","kind":"checkout"}
	}`)
	quoted := decodeJSON(t, itemJSON("example.com", "quoted", true))
	quoted["operation"], quoted["target"], quoted["source"] = "quote", "porkbun", "provider:porkbun"
	quoted["evidence"].(map[string]any)["offers"] = []any{offer}
	missing := decodeJSON(t, itemJSON("example.com", "credential_required", false))
	missing["id"] = "66666666-6666-4666-8666-666666666666"
	missing["operation"], missing["target"], missing["source"] = "quote", "namecheap", "provider:namecheap"
	rows := []string{}
	for _, row := range []map[string]any{quoted, missing} {
		b, err := json.Marshal(row)
		if err != nil {
			t.Fatal(err)
		}
		rows = append(rows, string(b))
	}
	f.reply("POST", "/api/v1/quotes", 201, envelope(jobJSON(jobSpec{typ: "quote", state: "queued", total: 2})))
	f.reply("GET", "/api/v1/jobs/"+jobID, 200, envelope(jobJSON(jobSpec{
		typ: "quote", state: "completed_with_errors", total: 2, finished: 2, unresolv: 1,
		outcomes: `{"quoted":1,"credential_required":1}`,
	})))
	f.on("GET", "/api/v1/events", sseHandler())
	f.reply("GET", "/api/v1/jobs/"+jobID+"/results", 200, page(rows, ""))

	r := newHarness(t).api(f, "quote", "example.com", "--providers", "porkbun,namecheap", "--wait", "--output", "json")
	expectCode(t, r, ExitAccess)
	out := decodeJSON(t, r.stdout)
	data, ok := out["data"].([]any)
	if out["contractVersion"] != "1.0.0" || !ok || len(data) != 2 {
		t.Fatalf("want a JSON envelope with both provider results: %s", r.stdout)
	}
	gotOffers := data[0].(map[string]any)["evidence"].(map[string]any)["offers"].([]any)
	if len(gotOffers) != 1 || !reflect.DeepEqual(gotOffers[0], offer) {
		t.Errorf("quote decision fields dropped, renamed or changed: got %#v, want %#v", gotOffers, offer)
	}
	if !reflect.DeepEqual(data[1], missing) {
		t.Errorf("credential_required provider result changed: got %#v, want %#v", data[1], missing)
	}
	if !strings.Contains(r.stderr, "credential_required") || !strings.Contains(r.stderr, "Submitted job "+jobID) {
		t.Errorf("missing progress or credential diagnostic on stderr: %s", r.stderr)
	}
}

func TestPricesPublishedReadsWholeExtensions(t *testing.T) {
	f := newFakeAPI(t)
	body := `{"contractVersion":"1.0.0","data":[{"suffix":"si","offers":[` +
		`{"providerId":"porkbun","providerName":"Porkbun","currency":"USD","registration":"20.38","registrationYears":1,"renewal":"17.50","renewalYears":1,"horizonYears":5,"horizonTotal":"90.38"},` +
		`{"providerId":"dynadot","providerName":"Dynadot","currency":"USD","registration":"21.99","registrationYears":1,"renewal":"19.99","renewalYears":1,"horizonYears":5,"horizonTotal":"101.95"}]}]}`
	f.reply("GET", "/api/v1/prices", 200, body)

	r := newHarness(t).api(f, "prices", "published", ".SI", "--years", "5")
	expectCode(t, r, ExitOK)
	reqs := f.requests("GET", "/api/v1/prices")
	if len(reqs) != 1 || reqs[0].query.Get("suffixes") != "si" || reqs[0].query.Get("horizonYears") != "5" {
		t.Fatalf("want one request for si over 5 years, got %#v", reqs)
	}
	if !reflect.DeepEqual(decodeJSON(t, r.stdout), decodeJSON(t, body)) {
		t.Fatalf("JSON output changed: %s", r.stdout)
	}

	table := newHarness(t).api(f, "prices", "published", "si", "--output", "table")
	expectCode(t, table, ExitOK)
	for _, want := range []string{"CHEAPEST", "porkbun", "20.38 USD", "17.50 USD", "90.38 USD / 5y"} {
		if !strings.Contains(table.stdout, want) {
			t.Errorf("table missing %q:\n%s", want, table.stdout)
		}
	}

	bad := newHarness(t).api(f, "prices", "published", "si", "--years", "0")
	expectCode(t, bad, ExitUsage)
}
