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
        else notes.push('No RDAP service in the IANA bootstrap and no verified WHOIS route with a registry-specific classifier.');
        notes.push('DNS and third-party aggregators are never used as a substitute.');
      } else {
        if (suffix !== tld) notes.push(`Routed through the .${tld} registry.`);
        if (route.whois?.notes) notes.push(route.whois.notes);
        if (route.whois) notes.push(`WHOIS host verified against ${route.whois.source}.`);
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
      'Bootstrap counts are not working-TLD counts. "discovered" means the IANA RDAP bootstrap or a curated WHOIS route names a registry endpoint; it does not show that the endpoint answers, classifies correctly or accepts registrations.',
      '"tested" means classifier fixtures exist for the suffix and/or an authorized live validation passed against the current endpoint. Fixtures marked reconstructed are derived from documentation and reference captures.',
      'A missing registry record (no_record) does not guarantee that a name can be registered, nor its price. Eligibility is reported only when a source states it.',
      'Unsupported suffixes are never checked through DNS, registrars or third-party aggregators.',
      `Live validation uses only the fixed public test set (example.com, google.com, nic.si, bbc.co.uk and random 24-character labels); ${data.liveValidation.results.length} results are recorded.`,
      `Coverage rows cover the ${data.rootTlds.count} TLDs in the IANA root list version ${data.rootTlds.version} plus individually tested second-level suffixes; other second-level suffixes inherit routing from their TLD without their own validation.`,
    ];
    if (data.liveValidation.notRun.length > 0) {
      limits.push(`Live validation was not run for: ${data.liveValidation.notRun.map((n) => `.${n.suffix} (${n.reason})`).join('; ')}.`);
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
