package cli

import (
	"strings"
	"testing"
)

// Offer tables carry what a purchase decision needs, and the purchase link is
// never clipped.
func TestOfferTableShowsPurchaseDetails(t *testing.T) {
	f := newFakeAPI(t)
	url := "https://porkbun.com/checkout/search?q=" + strings.Repeat("x", 80) + ".com"
	offer := `{"providerId":"porkbun","domain":null,"suffix":"com","purchasePath":"new_registration","kind":"catalog",` +
		`"currency":"USD","registration":{"amount":"10.37"},"renewal":{"amount":"11.08"},"transfer":{"amount":"10.37"},` +
		`"minYears":1,"fees":{"icann":"0.20","other":[],"tax":"unknown"},"premium":{"status":"not_premium"},` +
		`"freshness":"fresh","observedAt":"2026-10-27T10:00:00.000Z","destination":{"url":"` + url + `","kind":"search"}}`
	f.reply("GET", "/api/v1/domains/acme.com/offers", 200, page([]string{offer}, ""))
	r := newHarness(t).api(f, "--output", "table", "evidence", "offers", "acme.com")
	expectCode(t, r, ExitOK)
	lines := strings.Split(strings.TrimSpace(r.stdout), "\n")
	if len(lines) != 2 {
		t.Fatalf("want header and one row:\n%s", r.stdout)
	}
	for _, header := range []string{"REGISTRATION", "RENEWAL", "MIN YEARS", "ICANN FEE", "BUY"} {
		if !strings.Contains(lines[0], header) {
			t.Fatalf("header missing %s: %s", header, lines[0])
		}
	}
	for _, value := range []string{"10.37 USD", "11.08 USD", "0.20 USD", url} {
		if !strings.Contains(lines[1], value) {
			t.Fatalf("row missing %q: %s", value, lines[1])
		}
	}
	if !strings.HasSuffix(lines[1], url) {
		t.Fatalf("the link should be the last column: %s", lines[1])
	}
}
