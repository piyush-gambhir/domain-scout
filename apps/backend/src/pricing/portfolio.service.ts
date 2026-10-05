import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PortfolioEntry } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { decodeCursor, encodeCursor } from '../core/envelope.js';
import { AppError } from '../core/errors.js';
import { InputPreviewer } from '../core/ports.js';
import { Database } from '../storage/database.js';
import { ProvidersService } from '../providers/providers.service.js';
import { normalizeDomain } from './domain.js';
import { compare, dec, format, multiply, parseAmount, sum } from './money.js';
import { OffersService } from './offers.service.js';

interface EntryRow {
  id: string;
  domain: string;
  registrar: string | null;
  renewal_date: string | null;
  renewal_amount: string | null;
  renewal_currency: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PortfolioImportInput {
  text?: string;
  entries?: { domain: string; registrar?: string; renewalDate?: string; renewalPrice?: { amount: string; currency: string }; notes?: string }[];
  replace: boolean;
}

interface RawRow {
  row: number;
  input: string;
  domain: string;
  registrar?: string;
  renewalDate?: string;
  amount?: string;
  currency?: string;
  notes?: string;
}

const COLUMN_ALIASES: Record<string, keyof Omit<RawRow, 'row' | 'input'>> = {
  domain: 'domain',
  name: 'domain',
  registrar: 'registrar',
  renewaldate: 'renewalDate',
  renewal_date: 'renewalDate',
  'renewal date': 'renewalDate',
  renewalprice: 'amount',
  renewal_price: 'amount',
  'renewal price': 'amount',
  price: 'amount',
  currency: 'currency',
  notes: 'notes',
  note: 'notes',
};
const POSITIONAL: (keyof Omit<RawRow, 'row' | 'input'>)[] = ['domain', 'registrar', 'renewalDate', 'amount', 'currency', 'notes'];

/** RFC 4180 style CSV: quoted fields, doubled quotes, CRLF or LF line ends. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
    } else if (closed && c !== ',' && c !== '\n' && c !== '\r') {
      throw AppError.invalid(`Unexpected text after a closing quote on line ${rowLine}; nothing was imported`);
    } else if (c === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (c === '"') {
      throw AppError.invalid(`Unexpected quote in an unquoted field on line ${rowLine}; nothing was imported`);
    } else if (c === ',') {
      cells.push(cell);
      cell = '';
      closed = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = '';
      closed = false;
      line++;
      rowLine = line;
    } else {
      cell += c;
    }
  }
  if (quoted) throw AppError.invalid(`Unterminated quoted field starting on line ${rowLine}; nothing was imported`);
  if (cell !== '' || cells.length) {
    cells.push(cell);
    rows.push({ line: rowLine, cells });
  }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== '') && !r.cells[0]!.trim().startsWith('#'));
}

function csvRows(text: string): RawRow[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0]!.cells.map((c) => c.trim().toLowerCase());
  const hasHeader = header.some((h) => COLUMN_ALIASES[h] === 'domain');
  const columns = hasHeader ? header.map((h) => COLUMN_ALIASES[h] ?? null) : POSITIONAL;
  return rows.slice(hasHeader ? 1 : 0).map(({ line, cells }) => {
    const raw: RawRow = { row: line, input: cells.join(',').slice(0, 300), domain: '' };
    cells.forEach((value, i) => {
      const key = columns[i];
      const v = value.trim();
      if (key && v) raw[key] = v;
    });
    return raw;
  });
}

/**
 * User-supplied portfolio facts (renewal date and price), kept apart from observed prices and
 * estimates. Comparisons read retained offers only and never contact a provider.
 */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly providers: ProvidersService,
    private readonly offers: OffersService,
    @Optional() private readonly previewer?: InputPreviewer,
  ) {}

  import(input: PortfolioImportInput) {
    const raws: RawRow[] = [];
    if (input.text) raws.push(...csvRows(input.text));
    for (const [i, e] of (input.entries ?? []).entries()) {
      raws.push({
        row: i + 1,
        input: e.domain.slice(0, 300),
        domain: e.domain,
        registrar: e.registrar,
        renewalDate: e.renewalDate,
        amount: e.renewalPrice?.amount,
        currency: e.renewalPrice?.currency,
        notes: e.notes,
      });
    }
    const rejected: { row: number; input: string; reason: string }[] = [];
    const valid: Omit<EntryRow, 'id' | 'created_at' | 'updated_at'>[] = [];
    for (const raw of raws) {
      const problem = this.validate(raw);
      if (typeof problem === 'string') rejected.push({ row: raw.row, input: raw.input, reason: problem });
      else valid.push(problem);
    }
    let imported = 0;
    let updated = 0;
    const now = this.clock.iso();
    this.db.transaction(() => {
      if (input.replace) this.db.run('DELETE FROM portfolio_entries');
      for (const entry of valid) {
        const existing = this.db.get<{ id: string }>('SELECT id FROM portfolio_entries WHERE domain = ?', [entry.domain]);
        if (existing) {
          this.db.run(
            'UPDATE portfolio_entries SET registrar = ?, renewal_date = ?, renewal_amount = ?, renewal_currency = ?, notes = ?, updated_at = ? WHERE id = ?',
            [entry.registrar, entry.renewal_date, entry.renewal_amount, entry.renewal_currency, entry.notes, now, existing.id],
          );
          updated++;
        } else {
          this.db.run(
            `INSERT INTO portfolio_entries (id, domain, registrar, renewal_date, renewal_amount, renewal_currency, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), entry.domain, entry.registrar, entry.renewal_date, entry.renewal_amount, entry.renewal_currency, entry.notes, now, now],
          );
          imported++;
        }
      }
    });
    return { imported, updated, rejected };
  }

  private validate(raw: RawRow): Omit<EntryRow, 'id' | 'created_at' | 'updated_at'> | string {
    if (!raw.domain?.trim()) return 'Missing domain';
    const ref = normalizeDomain(raw.domain, this.previewer ?? null);
    if (!ref) return 'Not a registrable domain';
    let renewalDate: string | null = null;
    if (raw.renewalDate) {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.renewalDate);
      const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
      if (!match || !date || date.toISOString().slice(0, 10) !== raw.renewalDate) return 'Renewal date must be a valid YYYY-MM-DD date';
      renewalDate = raw.renewalDate;
    }
    let amount: string | null = null;
    let currency: string | null = null;
    if (raw.amount !== undefined || raw.currency !== undefined) {
      amount = raw.amount === undefined ? null : parseAmount(raw.amount);
      currency = raw.currency?.toUpperCase() ?? null;
      if (amount === null) return 'Renewal price must be a plain non-negative decimal amount';
      if (!currency || !/^[A-Z]{3}$/.test(currency)) return 'Renewal price needs a three-letter currency code';
    }
    if (raw.registrar && raw.registrar.length > 200) return 'Registrar is longer than 200 characters';
    if (raw.notes && raw.notes.length > 2000) return 'Notes are longer than 2000 characters';
    return {
      domain: ref.ascii,
      registrar: raw.registrar ?? null,
      renewal_date: renewalDate,
      renewal_amount: amount,
      renewal_currency: currency,
      notes: raw.notes ?? null,
    };
  }

  private toEntry(row: EntryRow): PortfolioEntry {
    return {
      id: row.id,
      domain: row.domain,
      registrar: row.registrar,
      renewalDate: row.renewal_date,
      renewalPrice: row.renewal_amount && row.renewal_currency ? { amount: row.renewal_amount, currency: row.renewal_currency } : null,
      notes: row.notes,
      source: 'user',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private page(cursor: string | null | undefined, limit: number) {
    const offset = decodeCursor<{ o: number }>(cursor)?.o ?? 0;
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM portfolio_entries')?.n ?? 0;
    const rows = this.db.all<EntryRow>('SELECT * FROM portfolio_entries ORDER BY domain LIMIT ? OFFSET ?', [limit, offset]);
    const nextCursor = offset + rows.length < total ? encodeCursor({ o: offset + rows.length }) : null;
    return { rows, nextCursor, total };
  }

  list(cursor: string | null | undefined, limit: number) {
    const { rows, nextCursor, total } = this.page(cursor, limit);
    return { items: rows.map((r) => this.toEntry(r)), nextCursor, total };
  }

  delete(id: string) {
    const { changes } = this.db.run('DELETE FROM portfolio_entries WHERE id = ?', [id]);
    if (!changes) throw AppError.notFound('Portfolio entry');
  }

  /** Renewal and transfer alternatives from retained offers; user facts, observations and estimates stay apart. */
  compare(cursor: string | null | undefined, limit: number) {
    const { rows, nextCursor, total } = this.page(cursor, limit);
    const horizon = 3;
    const items = rows.map((row) => {
      const entry = this.toEntry(row);
      const ref = normalizeDomain(row.domain, this.previewer ?? null);
      const notes: string[] = [];
      if (entry.renewalPrice || entry.renewalDate) notes.push('Renewal date and price are user-supplied, not observed');
      const alternatives = [];
      for (const manifest of this.providers.manifests()) {
        if (manifest.kind !== 'registrar' || !ref) continue;
        const priced = this.offers.latestQuote(manifest.id, ref.ascii, 'transfer') ?? this.offers.latestPublished(manifest.id, ref.suffix);
        if (!priced) continue;
        const offer = priced.offer;
        const transfer = offer.transfer.amount ? { amount: offer.transfer.amount, currency: offer.currency } : null;
        const renewal = offer.renewal.amount ? { amount: offer.renewal.amount, currency: offer.currency } : null;
        if (!transfer && !renewal) continue;
        alternatives.push({
          providerId: manifest.id,
          transfer,
          renewal,
          kind: offer.kind === 'exact_quote' ? ('exact_quote' as const) : ('published' as const),
          freshness: offer.freshness,
          observedAt: offer.observedAt,
          transferIncludesYears: offer.transfer.includesYears,
        });
        // Estimate: transfer plus current renewals over the horizon, in the same currency as the user's price.
        if (entry.renewalPrice && transfer && renewal && transfer.currency === entry.renewalPrice.currency && offer.transfer.includesYears !== null) {
          const stay = multiply(entry.renewalPrice.amount, horizon)!;
          const renewals = Math.max(0, horizon - offer.transfer.includesYears);
          const perYear = format(dec(renewal.amount).dividedBy(Math.max(1, offer.renewal.years)));
          const move = sum(transfer.amount, multiply(perYear, renewals))!;
          if (compare(move, stay) < 0) {
            notes.push(
              `Estimate: ${manifest.name} transfer plus renewals over ${horizon} years is ${move} ${transfer.currency} versus ${stay} at your renewal price (before tax and fees; current prices may change)`,
            );
          }
        }
      }
      if (!ref) notes.push('The stored domain could not be normalized for price lookup');
      else if (!alternatives.length) notes.push(`No retained prices for .${ref.suffix}; refresh catalogs or request transfer quotes`);
      return { entry, alternatives, notes };
    });
    return { items, nextCursor, total };
  }
}
