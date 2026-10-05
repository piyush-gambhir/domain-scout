import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { CoverageStatus, CoverageSummary, SuffixCoverage } from '@domain-scout/contracts';
import { domainToASCII } from 'node:url';
import { parse as parseHost } from 'tldts';
import { CoverageReader } from '../core/ports.js';
import { decodeCursor, encodeCursor } from '../core/envelope.js';
import { AppError } from '../core/errors.js';
import { Database, json } from '../storage/database.js';
import { loadRegistryData, type LiveValidationResult } from './data.js';
import { RDAP_PARSER_VERSION } from './rdap/rdap-classifier.js';
import { RoutesService, type RegistryRoute } from './routes.service.js';
import { WHOIS_PARSERS } from './whois/whois-classifiers.js';

interface SuffixRuleRow {
  suffix: string;
  tld: string;
  registry_id: string | null;
  protocol: 'rdap' | 'whois' | null;
  endpoint: string | null;
  routing: 'iana_bootstrap' | 'curated' | null;
  routing_updated_at: string | null;
  status: CoverageStatus;
  parser: string | null;
  notes_json: string;
}

interface RuleNotes {
  fixtureTested: boolean;
  fixtureKinds: string[];
  liveValidatedAt: string | null;
  liveValidation: SuffixCoverage['liveValidation'];
  eligibilityNotes: SuffixCoverage['eligibilityNotes'];
  notes: string | null;
}

/** Sourced eligibility rules the classifiers apply, shown per suffix. */
const ELIGIBILITY_NOTES: Record<string, SuffixCoverage['eligibilityNotes']> = {
  com: [
    {
      text: 'Records sponsored by IANA Registrar ID 376 (RESERVED-Internet Assigned Numbers Authority) are reported as reserved, e.g. example.com',
      source: 'https://www.iana.org/assignments/registrar-ids',
    },
  ],
  de: [
    {
      text: 'DENIC status "invalid" means the name cannot be registered; it is reported as invalid with restricted eligibility',
      source: 'https://docs.denic.de/en/Content/DENIC-29/Domain-Status.htm',
    },
  ],
  jp: [{ text: 'A JPRS state starting with "Reserved" is reported as reserved eligibility', source: 'JPRS WHOIS [State] field' }],
  be: [{ text: 'DNS Belgium status "NOT ALLOWED" (not a valid domain name) is reported as invalid with restricted eligibility', source: 'https://docs.dnsbelgium.be/be/general/whoisanddas.html' }],
  ch: [
    {
      text: 'SWITCH: a 404 "usually" means the name is not registered but not always that it can be registered; a 200 can also mean it cannot be registered at this time',
      source: 'https://www.nic.ch/whois/rdap/',
    },
  ],
  li: [
    {
      text: 'SWITCH: a 404 "usually" means the name is not registered but not always that it can be registered; a 200 can also mean it cannot be registered at this time',
      source: 'https://www.nic.li/whois/rdap/',
    },
  ],
  dk: [{ text: 'Status "Offered to waiting list" is reported as no record with restricted eligibility', source: 'https://github.com/Punktum-dk/whois-service-specification' }],
  ee: [
    {
      text: 'Unregistered names with status Reserved are reported as reserved; Blocked, AtAuction, PendingRegistration and Disputed as restricted',
      source: 'https://github.com/internetee/whois (app/models/whois_record.rb)',
    },
  ],
  it: [{ text: 'Status UNASSIGNABLE (geographical or reserved names) is reported as no record with reserved eligibility', source: 'Registro .it Synchronous Technical Guidelines v3.2, section 16.4' }],
  lt: [{ text: 'DOMREG DAS status "reserved" is reported as no record with reserved eligibility', source: 'https://www.domreg.lt/en/faq/for-registrars/how-to-get-the-information-on-domains/' }],
  lu: [{ text: 'DNS-LU domaintype RESERVED is reported as no record with reserved eligibility', source: 'https://dns.lu/en/domains/apiprotocols' }],
  se: [
    {
      text: 'Internetstiftelsen state "quarantine" is reported as no record with restricted eligibility and state "system" (reserved or blocked) as reserved',
      source: 'https://internetstiftelsen.se/app/uploads/2025/12/internetstiftelsen-service-description-whois-protocol.pdf',
    },
  ],
};

/**
 * Per-suffix support status (A02): tested (fixtures and/or passing authorized live validation),
 * discovered (a registry destination is known, classification untested) or unsupported. Rows are
 * persisted in suffix_rules so other modules can read them; they are rebuilt from bundled data at
 * startup and after a bootstrap refresh.
 */
@Injectable()
export class CoverageService extends CoverageReader implements OnModuleInit {
  constructor(
    private readonly db: Database,
    private readonly routes: RoutesService,
  ) {
    super();
  }

  onModuleInit() {
    this.sync();
  }

  /** Rebuilds suffix_rules from the current routes, fixture manifest and live validation record. */
  sync() {
    const data = loadRegistryData();
    // Fixtures count only for the protocol the suffix is currently routed through.
    const fixtures = new Map<string, Set<string>>();
    for (const fixture of data.fixtures.fixtures) {
      if (!fixture.suffix) continue;
      const key = `${fixture.protocol}:${fixture.suffix}`;
      const kinds = fixtures.get(key) ?? new Set<string>();
      kinds.add(fixture.kind);
      fixtures.set(key, kinds);
    }
    const fixtureSuffixes = data.fixtures.fixtures.map((fixture) => fixture.suffix).filter((suffix): suffix is string => suffix !== null);
    const live = new Map<string, LiveValidationResult[]>();
    for (const result of data.liveValidation.results) live.set(result.suffix, [...(live.get(result.suffix) ?? []), result]);
    const notRun = new Map(data.liveValidation.notRun.map((entry) => [entry.suffix, entry]));
    const withoutClassifier = new Map(data.whois.withoutClassifier.map((entry) => [entry.tld, entry]));

    const suffixes = new Set<string>(data.rootTlds.tlds);
    for (const route of this.routes.all()) suffixes.add(route.tld);
    for (const suffix of [...fixtureSuffixes, ...live.keys()]) suffixes.add(suffix);

    const rows: SuffixRuleRow[] = [];
    for (const suffix of [...suffixes].sort()) {
      const tld = suffix.slice(suffix.lastIndexOf('.') + 1);
      const route = this.routes.route(suffix);
      const results = live.get(suffix) ?? [];
      const passing = results.filter((r) => r.observed === r.expected && route !== null && r.destination === route.endpoint);
      const liveValidatedAt = passing.map((r) => r.at).sort().at(-1) ?? null;
      const kinds = route ? [...(fixtures.get(`${route.protocol}:${suffix}`) ?? [])].sort() : [];
      const fixtureTested = kinds.length > 0;
      const status: CoverageStatus = !route ? 'unsupported' : fixtureTested || liveValidatedAt ? 'tested' : 'discovered';

      const notes: string[] = [];
      if (!route) {
        const known = withoutClassifier.get(tld);
        const httpOnly = this.routes.httpOnlyEndpoints(tld);
        if (known) notes.push(known.reason);
        else if (httpOnly) notes.push(`The IANA bootstrap lists no usable https RDAP endpoint, only ${httpOnly.join(', ')}; plain-HTTP endpoints are not used.`);
        else notes.push('No RDAP service in the IANA bootstrap or curated registry list, and no verified WHOIS route with a registry-specific classifier.');
        notes.push('DNS and third-party aggregators are never used as a substitute.');
      } else {
        if (route.tld !== suffix) notes.push(`Routed through the .${route.tld} registry.`);
        if (route.curatedRdap) {
          notes.push(`Registry-published RDAP service not listed in the IANA bootstrap; base URL from ${route.curatedRdap.source}.`);
          if (route.curatedRdap.notes) notes.push(route.curatedRdap.notes);
        }
        if (route.whois?.notes) notes.push(route.whois.notes);
        if (route.whois) notes.push(`WHOIS host verified against ${route.whois.source}.`);
        const unserved = this.routes.unservedSecondLevel(suffix);
        if (route.tld === suffix && unserved.length > 0) {
          notes.push(unserved.includes('*') ? 'Second-level zones under this TLD are not routed.' : `Second-level zones not routed: ${unserved.map((zone) => `.${zone}`).join(', ')}.`);
        }
        if (fixtureTested && !kinds.includes('captured_live')) notes.push('Fixtures are reconstructed from documentation and reference captures, not captured live by this project.');
        const skipped = notRun.get(suffix);
        if (skipped && !liveValidatedAt) notes.push(`Live validation not run: ${skipped.reason}`);
        const failing = results.filter((r) => r.observed !== r.expected);
        if (failing.length > 0) notes.push(`${failing.length} live validation result(s) did not match the expected outcome.`);
      }

      const ruleNotes: RuleNotes = {
        fixtureTested,
        fixtureKinds: kinds,
        liveValidatedAt,
        liveValidation: results.map((r) => ({
          domain: r.domain,
          expected: r.expected as SuffixCoverage['liveValidation'][number]['expected'],
          observed: r.observed as SuffixCoverage['liveValidation'][number]['observed'],
          at: r.at,
        })),
        eligibilityNotes: ELIGIBILITY_NOTES[suffix] ?? [],
        notes: notes.length > 0 ? notes.join(' ') : null,
      };
      rows.push({
        suffix,
        tld,
        registry_id: route?.registryId ?? null,
        protocol: route?.protocol ?? null,
        endpoint: route?.endpoint ?? null,
        routing: route?.routing ?? null,
        routing_updated_at: route?.routingUpdatedAt ?? null,
        status,
        parser: route ? parserVersion(route) : null,
        notes_json: json.stringify(ruleNotes),
      });
    }

    this.db.transaction(() => {
      this.db.run('DELETE FROM suffix_rules');
      for (const row of rows) {
        this.db.run(
          `INSERT INTO suffix_rules (suffix, tld, registry_id, protocol, endpoint, routing, routing_updated_at, status, parser, notes_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.suffix, row.tld, row.registry_id, row.protocol, row.endpoint, row.routing, row.routing_updated_at, row.status, row.parser, row.notes_json],
        );
      }
    });
  }

  counts(): { tested: number; discovered: number; unsupported: number } {
    const out = { tested: 0, discovered: 0, unsupported: 0 };
    for (const row of this.db.all<{ status: CoverageStatus; n: number }>('SELECT status, COUNT(*) AS n FROM suffix_rules GROUP BY status')) {
      out[row.status] = Number(row.n);
    }
    return out;
  }

  summary(): CoverageSummary {
    const data = loadRegistryData();
    const info = this.routes.bootstrapInfo();
    const counts = this.counts();
    const limits = [
      'Bootstrap counts are not working-TLD counts. "discovered" means the IANA RDAP bootstrap, a registry-published RDAP service or a curated WHOIS route names a registry endpoint; it does not show that the endpoint answers, classifies correctly or accepts registrations.',
      '"tested" means classifier fixtures exist for the suffix and/or an authorized live validation passed against the current endpoint. Fixtures marked reconstructed are derived from documentation and reference captures.',
      'A missing registry record (no_record) does not guarantee that a name can be registered, nor its price. Eligibility is reported only when a source states it.',
      'Unsupported suffixes are never checked through DNS, registrars or third-party aggregators.',
      `Live validation uses only the fixed public test set (example.com, google.com, nic.si, bbc.co.uk and random 24-character labels); ${data.liveValidation.results.length} results are recorded.`,
      `Coverage rows cover the ${data.rootTlds.count} TLDs in the IANA root list version ${data.rootTlds.version} plus individually tested second-level suffixes; other second-level suffixes inherit routing from their TLD without their own validation.`,
    ];
    if (data.liveValidation.notRun.length > 0) {
      const byReason = new Map<string, string[]>();
      for (const entry of data.liveValidation.notRun) byReason.set(entry.reason, [...(byReason.get(entry.reason) ?? []), `.${entry.suffix}`]);
      limits.push(`Live validation was not run for: ${[...byReason].map(([reason, suffixes]) => `${suffixes.join(', ')} (${reason})`).join('; ')}.`);
    }
    return {
      bootstrapPublishedAt: info.publishedAt,
      bootstrapFetchedAt: toIsoOrNull(info.fetchedAt),
      counts,
      limits,
    };
  }

  list(query: { status?: CoverageStatus; q?: string; cursor?: string; limit: number }): { items: SuffixCoverage[]; nextCursor: string | null; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (query.status) {
      where.push('status = ?');
      params.push(query.status);
    }
    const q = query.q ? normalizeSuffix(query.q) : '';
    if (q) {
      where.push("suffix LIKE ? ESCAPE '\\'");
      params.push(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM suffix_rules ${filter}`, params)?.n ?? 0);
    const decoded = query.cursor ? decodeCursor<{ after?: unknown }>(query.cursor) : null;
    if (query.cursor && typeof decoded?.after !== 'string') throw AppError.invalid('Invalid cursor', [{ path: 'query.cursor', message: 'Not a cursor returned by this endpoint' }]);
    const after = decoded?.after as string | undefined;
    const pageWhere = after ? `${filter ? `${filter} AND` : 'WHERE'} suffix > ?` : filter;
    const rows = this.db.all<SuffixRuleRow>(`SELECT * FROM suffix_rules ${pageWhere} ORDER BY suffix LIMIT ?`, [
      ...params,
      ...(after ? [after] : []),
      query.limit + 1,
    ]);
    const more = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toCoverage);
    return { items, nextCursor: more ? encodeCursor({ after: items.at(-1)!.suffix }) : null, total };
  }

  /** Coverage for one suffix. Untested second-level suffixes inherit their TLD's route as discovered. */
  get(input: string): SuffixCoverage {
    const suffix = normalizeSuffix(input);
    const row = this.db.get<SuffixRuleRow>('SELECT * FROM suffix_rules WHERE suffix = ?', [suffix]);
    if (row) return toCoverage(row);

    const parsed = parseHost(`x.${suffix}`, { allowPrivateDomains: false, extractHostname: false, validateHostname: false });
    const tld = suffix.slice(suffix.lastIndexOf('.') + 1);
    const tldRow = this.db.get<SuffixRuleRow>('SELECT * FROM suffix_rules WHERE suffix = ?', [tld]);
    if (!suffix.includes('.') || !tldRow || !parsed.isIcann || parsed.publicSuffix !== suffix) {
      throw AppError.notFound(`Suffix ${input}`);
    }
    const base = toCoverage(tldRow);
    if (base.status !== 'unsupported' && this.routes.route(suffix) === null) {
      return {
        ...base,
        suffix,
        status: 'unsupported',
        protocol: null,
        endpoint: null,
        registryId: null,
        routing: null,
        routingUpdatedAt: null,
        fixtureTested: false,
        liveValidatedAt: null,
        liveValidation: [],
        eligibilityNotes: [],
        notes: `No verified registry lookup: ${this.routes.unsupportedReason(suffix)}. DNS and third-party aggregators are never used as a substitute.`,
      };
    }
    return {
      ...base,
      suffix,
      status: base.status === 'tested' ? 'discovered' : base.status,
      fixtureTested: false,
      liveValidatedAt: null,
      liveValidation: [],
      eligibilityNotes: [],
      notes:
        base.status === 'unsupported'
          ? base.notes
          : `Second-level suffix routed through the .${tld} registry; no fixtures or live validation of its own.`,
    };
  }
}

function parserVersion(route: RegistryRoute): string {
  if (route.protocol === 'rdap') return RDAP_PARSER_VERSION;
  return WHOIS_PARSERS[route.whois?.parser ?? '']?.version ?? 'none';
}

function normalizeSuffix(input: string): string {
  const cleaned = input.trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '');
  return domainToASCII(cleaned) || cleaned;
}

function toIsoOrNull(value: string | null) {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

function toCoverage(row: SuffixRuleRow): SuffixCoverage {
  const notes = json.parse<RuleNotes>(row.notes_json, {
    fixtureTested: false,
    fixtureKinds: [],
    liveValidatedAt: null,
    liveValidation: [],
    eligibilityNotes: [],
    notes: null,
  });
  return {
    suffix: row.suffix,
    tld: row.tld,
    status: row.status,
    protocol: row.protocol,
    endpoint: row.endpoint,
    registryId: row.registry_id,
    routing: row.routing,
    routingUpdatedAt: row.routing_updated_at,
    fixtureTested: notes.fixtureTested,
    liveValidatedAt: notes.liveValidatedAt,
    liveValidation: notes.liveValidation,
    eligibilityNotes: notes.eligibilityNotes,
    notes: notes.notes,
  };
}
