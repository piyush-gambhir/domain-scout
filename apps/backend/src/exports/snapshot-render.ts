import { UNCERTAINTY_NOTICE } from './rows.js';

/** Structured snapshot content. The HTML is rendered from exactly this data. */
export interface SnapshotItem {
  domain: string;
  unicode: string;
  suffix: string;
  registry?: {
    outcome: string;
    checkedAt: string;
    freshnessAtCreation: string;
    source: string | null;
    protocol: string | null;
    reason: string | null;
    eligibility: string | null;
  } | null;
  confirmations?: { providerId: string; status: string; checkedAt: string; freshnessAtCreation: string }[];
  /** Name checks, diagnostics and listings carried by job items in scope. */
  checks?: {
    kind: string;
    label: string;
    outcome: string;
    checkedAt: string;
    freshnessAtCreation: string | null;
    source: string | null;
    reason: string | null;
  }[];
  registration?: {
    registrar: string | null;
    createdAt: string | null;
    expiresAt: string | null;
    statuses: string[];
    nameservers: string[];
  } | null;
  prices?: {
    providerId: string;
    kind: string;
    purchasePath: string;
    currency: string;
    region: string | null;
    years: number | null;
    registration: string | null;
    renewal: string | null;
    observedAt: string | null;
    freshnessAtCreation: string | null;
    source: string | null;
  }[];
  notes?: string | null;
}

export interface SnapshotDocument {
  contractVersion: string;
  kind: 'domain-scout-snapshot';
  id: string;
  title: string;
  createdAt: string;
  scope: unknown;
  scopeLabel: string;
  resolved: unknown;
  include: { evidence: boolean; prices: boolean; registration: boolean; notes: boolean };
  notice: string[];
  items: SnapshotItem[];
}

const OUTCOME_LABELS: Record<string, string> = {
  registered: 'Registered',
  no_record: 'No registry record',
  inconclusive: 'Inconclusive (unresolved)',
  rate_limited: 'Rate limited (unresolved)',
  blocked: 'Blocked (unresolved)',
  invalid: 'Invalid name',
  unsupported: 'Unsupported extension (unresolved)',
};

const KIND_LABELS: Record<string, string> = {
  published: 'Published price',
  estimated: 'Estimate',
  exact_quote: 'Exact-name quote',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

function orUnknown(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? '<span class="muted">unknown</span>' : e(value);
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--muted:#71717a;--tint:#f0f0f2;--note:#f6f3ea}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececef;--muted:#a1a1aa;--tint:#1c1c20;--note:#24221b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:40px 20px 64px}
h1{font-size:24px;margin:0 0 4px;font-weight:600}
h2{font-size:18px;margin:0;font-weight:600;word-break:break-all}
h3{font-size:13px;margin:20px 0 6px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.meta,.muted,.ascii{color:var(--muted)}
.meta{margin:0 0 24px}
.notice{background:var(--note);border-radius:10px;padding:14px 18px;margin:0 0 32px}
.notice p{margin:4px 0}
article{background:var(--tint);border-radius:12px;padding:20px 22px;margin:0 0 16px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 18px;margin:8px 0 0}
dt{color:var(--muted)}dd{margin:0;word-break:break-word}
table{border-collapse:collapse;width:100%;font-size:14px}
th{text-align:left;color:var(--muted);font-weight:500;padding:4px 12px 4px 0}
td{padding:4px 12px 4px 0;vertical-align:top}
.wrap{overflow-x:auto}
.notes{white-space:pre-wrap;margin:0}
footer{color:var(--muted);font-size:13px;margin-top:32px}
`;

/**
 * Self-contained HTML: inline CSS only, no scripts, no external assets, every value escaped, and a
 * Content-Security-Policy that blocks any network request when the file is opened.
 */
export function renderSnapshotHtml(doc: SnapshotDocument): string {
  const items = doc.items.map(renderItem).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${e(doc.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${e(doc.title)}</h1>
<p class="meta">Created ${e(doc.createdAt)} (UTC). Scope: ${e(doc.scopeLabel)}. ${doc.items.length} ${doc.items.length === 1 ? 'name' : 'names'}.</p>
<section class="notice">
${doc.notice.map((line) => `<p>${e(line)}</p>`).join('\n')}
<p>Freshness is shown as it was when this snapshot was created. Opening this file runs no checks.</p>
</section>
${items || '<p class="muted">No names in scope.</p>'}
<footer>Domain Scout snapshot ${e(doc.id)}. Contract ${e(doc.contractVersion)}.</footer>
</main>
</body>
</html>
`;
}

function renderItem(item: SnapshotItem): string {
  const parts: string[] = [`<article>`, `<h2>${e(item.unicode)}</h2>`];
  if (item.unicode !== item.domain) parts.push(`<div class="ascii">${e(item.domain)}</div>`);
  if (item.registry !== undefined) {
    parts.push('<h3>Registry</h3>');
    if (!item.registry) parts.push('<p class="muted">No registry evidence retained.</p>');
    else {
      const r = item.registry;
      parts.push(
        '<dl>',
        `<dt>Outcome</dt><dd>${e(OUTCOME_LABELS[r.outcome] ?? r.outcome)}</dd>`,
        `<dt>Checked</dt><dd>${e(r.checkedAt)}</dd>`,
        `<dt>Freshness</dt><dd>${e(r.freshnessAtCreation)} at snapshot creation</dd>`,
        `<dt>Source</dt><dd>${orUnknown(r.protocol ? `${r.protocol.toUpperCase()} ${r.source ?? ''}`.trim() : r.source)}</dd>`,
        `<dt>Reason</dt><dd>${orUnknown(r.reason)}</dd>`,
        `<dt>Eligibility</dt><dd>${orUnknown(r.eligibility)}</dd>`,
        '</dl>',
      );
    }
  }
  if (item.confirmations !== undefined) {
    parts.push('<h3>Provider confirmations</h3>');
    if (!item.confirmations.length) parts.push('<p class="muted">None requested.</p>');
    else
      parts.push(
        '<div class="wrap"><table><thead><tr><th>Provider</th><th>Status</th><th>Checked</th><th>Freshness</th></tr></thead><tbody>',
        ...item.confirmations.map(
          (c) =>
            `<tr><td>${e(c.providerId)}</td><td>${e(c.status)}</td><td>${e(c.checkedAt)}</td><td>${e(c.freshnessAtCreation)}</td></tr>`,
        ),
        '</tbody></table></div>',
      );
  }
  if (item.checks?.length) {
    parts.push(
      '<h3>Other checks</h3>',
      '<div class="wrap"><table><thead><tr><th>Check</th><th>Outcome</th><th>Checked</th><th>Freshness</th><th>Destination</th><th>Reason</th></tr></thead><tbody>',
      ...item.checks.map(
        (c) =>
          `<tr><td>${e(c.label)}</td><td>${e(c.outcome.replace(/_/g, ' '))}</td><td>${e(c.checkedAt)}</td><td>${orUnknown(c.freshnessAtCreation)}</td>` +
          `<td>${orUnknown(c.source)}</td><td>${orUnknown(c.reason)}</td></tr>`,
      ),
      '</tbody></table></div>',
    );
  }
  if (item.registration !== undefined) {
    parts.push('<h3>Registration details</h3>');
    if (!item.registration) parts.push('<p class="muted">None returned.</p>');
    else {
      const d = item.registration;
      parts.push(
        '<dl>',
        `<dt>Registrar</dt><dd>${orUnknown(d.registrar)}</dd>`,
        `<dt>Created</dt><dd>${orUnknown(d.createdAt)}</dd>`,
        `<dt>Expires</dt><dd>${orUnknown(d.expiresAt)} <span class="muted">(registry date, not a drop prediction)</span></dd>`,
        `<dt>Statuses</dt><dd>${d.statuses.length ? e(d.statuses.join(', ')) : '<span class="muted">none</span>'}</dd>`,
        `<dt>Nameservers</dt><dd>${d.nameservers.length ? e(d.nameservers.join(', ')) : '<span class="muted">none</span>'}</dd>`,
        '</dl>',
      );
    }
  }
  if (item.prices !== undefined) {
    parts.push('<h3>Prices</h3>');
    if (!item.prices.length) parts.push('<p class="muted">No price known.</p>');
    else
      parts.push(
        '<div class="wrap"><table><thead><tr><th>Provider</th><th>Type</th><th>Path</th><th>Registration</th><th>Renewal</th><th>Observed</th><th>Freshness</th></tr></thead><tbody>',
        ...item.prices.map(
          (p) =>
            `<tr><td>${e(p.providerId)}</td><td>${e(KIND_LABELS[p.kind] ?? p.kind)}</td><td>${e(p.purchasePath.replace(/_/g, ' '))}${p.region ? ` (${e(p.region)})` : ''}</td>` +
            `<td>${money(p.registration, p.currency, p.years)}</td><td>${money(p.renewal, p.currency, null)}</td>` +
            `<td>${orUnknown(p.observedAt)}</td><td>${orUnknown(p.freshnessAtCreation)}</td></tr>`,
        ),
        '</tbody></table></div>',
      );
  }
  if (item.notes !== undefined && item.notes !== null && item.notes !== '') {
    parts.push('<h3>Notes</h3>', `<p class="notes">${e(item.notes)}</p>`);
  }
  parts.push('</article>');
  return parts.join('\n');
}

function money(amount: string | null, currency: string, years: number | null): string {
  if (amount === null) return '<span class="muted">unknown</span>';
  return `${e(amount)} ${e(currency)}${years && years > 1 ? ` for ${years} years` : ''}`;
}
