import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Collection, CollectionEntry } from '@domain-scout/contracts';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { Database } from '../storage/database.js';
import { EvidenceReader } from '../evidence/evidence-reader.service.js';
import { pageWindow } from '../evidence/paging.js';

interface CollectionRow {
  id: string;
  name: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  entry_count: number;
}

interface EntryRow {
  id: string;
  collection_id: string;
  domain: string;
  unicode: string;
  notes: string | null;
  added_at: string;
}

const COLLECTION_SELECT = `SELECT c.*, (SELECT COUNT(*) FROM collection_entries e WHERE e.collection_id = c.id) AS entry_count FROM collections c`;

/** Shortlists. Deleting a collection or entry never deletes evidence. */
@Injectable()
export class CollectionsService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly reader: EvidenceReader,
  ) {}

  list(cursor: string | undefined, limit: number) {
    const page = pageWindow(cursor, limit);
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM collections')!.n;
    const rows = this.db.all<CollectionRow>(`${COLLECTION_SELECT} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`, [
      page.limit,
      page.offset,
    ]);
    return { items: rows.map(toCollection), nextCursor: page.next(rows.length, total), total };
  }

  get(id: string): Collection {
    const row = this.db.get<CollectionRow>(`${COLLECTION_SELECT} WHERE c.id = ?`, [id]);
    if (!row) throw AppError.notFound('Collection');
    return toCollection(row);
  }

  create(body: { name: string; notes?: string }): Collection {
    const id = randomUUID();
    const now = this.clock.iso();
    this.db.run('INSERT INTO collections (id, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      body.name,
      body.notes ?? null,
      now,
      now,
    ]);
    return this.get(id);
  }

  patch(id: string, body: { name?: string; notes?: string | null }): Collection {
    const current = this.get(id);
    this.db.run('UPDATE collections SET name = ?, notes = ?, updated_at = ? WHERE id = ?', [
      body.name ?? current.name,
      body.notes === undefined ? current.notes : body.notes,
      this.clock.iso(),
      id,
    ]);
    return this.get(id);
  }

  delete(id: string) {
    this.get(id);
    this.db.run('DELETE FROM collections WHERE id = ?', [id]);
  }

  entries(id: string, cursor: string | undefined, limit: number) {
    this.get(id);
    const page = pageWindow(cursor, limit);
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM collection_entries WHERE collection_id = ?', [id])!.n;
    const rows = this.db.all<EntryRow>(
      'SELECT * FROM collection_entries WHERE collection_id = ? ORDER BY added_at, domain LIMIT ? OFFSET ?',
      [id, page.limit, page.offset],
    );
    return { items: rows.map((row) => this.toEntry(row)), nextCursor: page.next(rows.length, total), total };
  }

  /** All entries without evidence, in shortlist order (for exports). */
  entryRows(id: string): { domain: string; unicode: string; notes: string | null }[] {
    this.get(id);
    return this.db.all<EntryRow>('SELECT * FROM collection_entries WHERE collection_id = ? ORDER BY added_at, domain', [id]);
  }

  addEntries(id: string, body: { domains: string[]; notes?: string }) {
    this.get(id);
    const rejected: { input: string; reason: string }[] = [];
    const accepted: { ascii: string; unicode: string }[] = [];
    const seen = new Set<string>();
    let existing = 0;
    for (const raw of body.domains) {
      const input = raw.trim();
      if (!input) {
        rejected.push({ input: raw, reason: 'Empty input' });
        continue;
      }
      const normalized = this.reader.normalize(input);
      if (!normalized) {
        rejected.push({ input: raw, reason: 'Not a valid registrable domain' });
        continue;
      }
      if (seen.has(normalized.ascii)) {
        existing++;
        continue;
      }
      seen.add(normalized.ascii);
      accepted.push({ ascii: normalized.ascii, unicode: normalized.unicode });
    }
    const now = this.clock.iso();
    let added = 0;
    this.db.transaction(() => {
      for (const entry of accepted) {
        const { changes } = this.db.run(
          `INSERT INTO collection_entries (id, collection_id, domain, unicode, notes, added_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (collection_id, domain) DO NOTHING`,
          [randomUUID(), id, entry.ascii, entry.unicode, body.notes ?? null, now],
        );
        if (changes > 0) added++;
        else existing++;
      }
      this.db.run('UPDATE collections SET updated_at = ? WHERE id = ?', [now, id]);
    });
    return { added, existing, rejected };
  }

  removeEntries(id: string, domains: string[]) {
    this.get(id);
    const removed: string[] = [];
    this.db.transaction(() => {
      for (const domain of new Set(domains)) {
        const { changes } = this.db.run('DELETE FROM collection_entries WHERE collection_id = ? AND domain = ?', [id, domain]);
        if (changes > 0) removed.push(domain);
      }
      if (removed.length) this.db.run('UPDATE collections SET updated_at = ? WHERE id = ?', [this.clock.iso(), id]);
    });
    return { domains: removed };
  }

  patchEntry(id: string, domainParam: string, notes: string | null) {
    this.get(id);
    const domain = this.reader.normalize(domainParam)?.ascii ?? domainParam.trim().toLowerCase();
    const { changes } = this.db.run('UPDATE collection_entries SET notes = ? WHERE collection_id = ? AND domain = ?', [
      notes,
      id,
      domain,
    ]);
    if (changes === 0) throw AppError.notFound('Collection entry');
    this.db.run('UPDATE collections SET updated_at = ? WHERE id = ?', [this.clock.iso(), id]);
  }

  private toEntry(row: EntryRow): CollectionEntry {
    const suffix = this.reader.normalize(row.domain)?.suffix ?? row.domain.slice(row.domain.indexOf('.') + 1);
    const latest = this.reader.latest(row.domain, suffix);
    return {
      id: row.id,
      collectionId: row.collection_id,
      domain: row.domain,
      unicode: row.unicode,
      notes: row.notes,
      addedAt: row.added_at,
      registry: latest.registry,
      confirmations: latest.confirmations,
      offers: latest.offers,
    };
  }
}

function toCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    name: row.name,
    notes: row.notes,
    entryCount: Number(row.entry_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
