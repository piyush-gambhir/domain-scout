package cli

// Table columns per resource. JSON output ignores these.
var (
	plainView = view{}

	jobView     = view{}
	jobListView = view{cols: []col{
		c("ID", "id"), c("TYPE", "type"), c("STATE", "state"), c("LABEL", "label"),
		{header: "FINISHED", fn: ratio("counters.finished", "counters.total")},
		c("UNRESOLVED", "counters.unresolved"), c("CREATED", "createdAt"),
	}}
	resultView = view{cols: []col{
		c("SUBJECT", "subject"), c("OPERATION", "operation"), c("TARGET", "target"), c("STATE", "state"),
		c("OUTCOME", "outcome"), c("RESOLVED", "resolved"), c("CHECKED", "evidence.registry.checkedAt"),
		{header: "BEST PRICE", fn: money("bestPrice.amount", "bestPrice.currency")},
		c("ERROR", "error.code"), c("RETRY AT", "retryAt"),
	}}
	eventView = view{cols: []col{
		c("EVENT", "eventId"), c("OCCURRED", "occurredAt"), c("TYPE", "type"), c("JOB", "jobId"), c("WATCH", "watchId"),
	}}

	inputPreviewView = view{
		list: "rows",
		summary: []col{
			c("input rows", "counts.inputRows"), c("valid", "counts.valid"), c("duplicate", "counts.duplicate"),
			c("invalid", "counts.invalid"), c("ambiguous", "counts.ambiguous"),
			c("unique domains", "counts.uniqueDomains"), c("total checks", "counts.totalChecks"), c("extensions", "extensions"),
		},
		cols: []col{
			c("ROW", "row"), c("ORIGINAL", "original"), c("STATUS", "status"), c("DOMAIN", "domain.ascii"),
			c("SUGGESTION", "suggestion"), {header: "REASONS", fn: pluck("reasons", "code")},
		},
	}

	coverageView = view{cols: []col{
		c("SUFFIX", "suffix"), c("STATUS", "status"), c("PROTOCOL", "protocol"), c("ENDPOINT", "endpoint"),
		c("ROUTING", "routing"), c("FIXTURES", "fixtureTested"), c("LIVE VALIDATED", "liveValidatedAt"),
	}}
	coverageSummaryView = view{}

	providerView = view{cols: []col{
		c("ID", "id"), c("NAME", "name"), c("KIND", "kind"), c("ENABLED", "enabled"), c("PREFERRED", "preferred"),
		c("READINESS", "readiness"), c("CATALOG", "catalog.freshness"), c("CREDENTIALS", "credentials.storage"),
	}}
	credentialTestView = view{}
	offerView          = view{cols: []col{
		c("PROVIDER", "providerId"), c("DOMAIN", "domain"), c("SUFFIX", "suffix"), c("PATH", "purchasePath"),
		c("KIND", "kind"), c("CURRENCY", "currency"), c("REGISTRATION", "registration.amount"),
		c("RENEWAL", "renewal.amount"), c("TRANSFER", "transfer.amount"), c("PREMIUM", "premium.status"),
		c("FRESHNESS", "freshness"), c("OBSERVED", "observedAt"),
	}}
	comparisonView = view{
		list:    "rows",
		summary: []col{c("horizon years", "horizonYears"), c("purchase path", "purchasePath"), c("currency", "currency"), c("limits", "limits")},
		cols: []col{
			c("DOMAIN", "domain"), c("PROVIDER", "providerId"), c("KIND", "kind"), c("CURRENCY", "currency"),
			c("INITIAL", "initialCommitment"), c("HORIZON TOTAL", "horizonTotal"), c("SUBTOTAL ONLY", "subtotalOnly"),
			c("COMPLETE", "complete"), c("RANK", "rank"), c("MISSING", "missing"), c("FRESHNESS", "freshness"),
		},
	}
	// Offers arrive lowest first-year price first within each currency, so the first one is the
	// cheapest in its currency.
	suffixPricesView = view{cols: []col{
		c("SUFFIX", "suffix"), {header: "PROVIDERS", fn: count("offers")},
		{header: "CHEAPEST", fn: firstOffer(func(o map[string]any) string { return cell(o["providerId"]) })},
		{header: "FIRST YEAR", fn: firstOffer(money("registration", "currency"))},
		{header: "RENEWAL", fn: firstOffer(money("renewal", "currency"))},
		{header: "HORIZON", fn: firstOffer(func(o map[string]any) string {
			return money("horizonTotal", "currency")(o) + " / " + cell(o["horizonYears"]) + "y"
		})},
	}}
	priceHistoryView = view{cols: []col{
		c("PROVIDER", "providerId"), c("SCOPE", "scope"), c("PATH", "purchasePath"), c("CURRENCY", "currency"),
		c("REGION", "region"), c("TERM", "termYears"), c("PROMO", "promotional"),
		{header: "POINTS", fn: count("points")}, {header: "GAPS", fn: count("gaps")},
	}}
	transferOptionView = view{cols: []col{
		c("DOMAIN", "domain"), c("PROVIDER", "providerId"), {header: "TRANSFER", fn: money("transfer.amount", "transfer.currency")},
		c("YEARS", "includesYears"), {header: "RENEWAL", fn: money("renewal.amount", "renewal.currency")},
		c("KIND", "kind"), c("FRESHNESS", "freshness"), c("OBSERVED", "observedAt"),
	}}
	listingView = view{cols: []col{
		c("DOMAIN", "domain"), c("MARKETPLACE", "marketplace"), c("STATUS", "status"),
		{header: "PRICE", fn: money("price.amount", "price.currency")}, c("FRESHNESS", "freshness"),
		c("OBSERVED", "observedAt"), c("URL", "url"),
	}}
	aftermarketSourceView = view{cols: []col{
		c("ID", "id"), c("NAME", "name"), c("SUPPORTED", "supported"), c("CREDENTIALS", "requiresCredentials"), c("REASON", "reason"),
	}}
	nameCheckServiceView = view{cols: []col{
		c("ID", "id"), c("NAME", "name"), c("NAMESPACE", "namespace"), c("SUPPORTED", "supported"),
		c("DESTINATION", "destination"), c("REASON", "reason"),
	}}

	collectionView      = view{cols: []col{c("ID", "id"), c("NAME", "name"), c("ENTRIES", "entryCount"), c("NOTES", "notes"), c("UPDATED", "updatedAt")}}
	collectionEntryView = view{cols: []col{
		c("DOMAIN", "domain"), c("OUTCOME", "registry.outcome"), c("CHECKED", "registry.checkedAt"),
		c("FRESHNESS", "registry.freshness"), {header: "OFFERS", fn: count("offers")}, c("NOTES", "notes"),
	}}
	criteriaView = view{cols: []col{c("ID", "id"), c("NAME", "name"), c("EXTENSIONS", "extensions"), c("PROVIDERS", "providerIds"), c("UPDATED", "updatedAt")}}
	presetView   = view{cols: []col{c("ID", "id"), c("NAME", "name"), c("BUILT IN", "builtIn"), c("EXTENSIONS", "extensions")}}

	generationView = view{
		list: "candidates",
		summary: []col{
			c("generated", "counts.generated"), c("unique", "counts.unique"), c("duplicates", "counts.duplicates"),
			c("invalid", "counts.invalid"), c("filtered", "counts.filtered"), c("extensions", "extensions"),
			c("expanded checks", "expandedChecks"),
		},
		cols: []col{c("NAME", "name"), c("DOMAIN", "domain"), c("STRATEGY", "strategy"), c("VALID", "valid"), c("RULE", "rule"), c("ISSUES", "issues")},
	}
	themeView = view{cols: []col{c("ID", "id"), c("NAME", "name"), c("SIZE", "size"), c("SAMPLE", "sample")}}

	watchView = view{cols: []col{
		c("ID", "id"), c("NAME", "name"), c("STATE", "state"), {header: "DOMAINS", fn: count("domains")},
		c("INTERVAL MIN", "intervalMinutes"), c("NEXT RUN", "nextRunAt"), c("MISSED", "missedRuns"), c("UNREAD", "unreadNotices"),
	}}
	watchRunView = view{cols: []col{
		c("ID", "id"), c("STATUS", "status"), c("SCHEDULED", "scheduledFor"), c("FINISHED", "finishedAt"),
		c("JOB", "jobId"), c("CHANGES", "changes"), c("FAILURES", "failures"), c("NOTE", "note"),
	}}
	noticeView = view{cols: []col{
		c("ID", "id"), c("DOMAIN", "domain"), c("TYPE", "type"), c("SUMMARY", "summary"),
		c("BEFORE", "before.value"), c("AFTER", "after.value"), c("CREATED", "createdAt"), c("READ", "readAt"),
	}}

	historyView = view{cols: []col{
		c("JOB", "jobId"), c("TYPE", "type"), c("STATE", "state"), c("LABEL", "label"), c("TOTAL", "total"),
		c("UNRESOLVED", "unresolved"), c("RESUMABLE", "resumable"), c("CREATED", "createdAt"),
	}}
	portfolioView = view{cols: []col{
		c("ID", "id"), c("DOMAIN", "domain"), c("REGISTRAR", "registrar"), c("RENEWAL DATE", "renewalDate"),
		{header: "RENEWAL PRICE", fn: money("renewalPrice.amount", "renewalPrice.currency")}, c("NOTES", "notes"),
	}}
	portfolioCompareView = view{cols: []col{
		c("DOMAIN", "entry.domain"), c("REGISTRAR", "entry.registrar"),
		{header: "CURRENT RENEWAL", fn: money("entry.renewalPrice.amount", "entry.renewalPrice.currency")},
		{header: "ALTERNATIVES", fn: pluck("alternatives", "providerId")}, c("NOTES", "notes"),
	}}

	exportView   = view{cols: []col{c("ID", "id"), c("FORMAT", "format"), c("ITEMS", "itemCount"), c("FILE", "fileName"), c("BYTES", "sizeBytes"), c("CREATED", "createdAt")}}
	snapshotView = view{cols: []col{c("ID", "id"), c("TITLE", "title"), c("ITEMS", "itemCount"), c("BYTES", "sizeBytes"), c("CREATED", "createdAt")}}

	dataInventoryView = view{
		list:    "categories",
		summary: []col{c("data dir", "dataDir"), c("database bytes", "databaseBytes")},
		cols:    []col{c("CATEGORY", "category"), c("COUNT", "count")},
	}
	dataDeleteView = view{list: "deleted", cols: []col{c("CATEGORY", "category"), c("DELETED", "count")}}
)
