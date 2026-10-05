import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { SavedCriteria, SavedCriteriaCreate } from '@domain-scout/contracts';
import type { z } from 'zod';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { Database, json } from '../storage/database.js';

type CriteriaInput = z.output<typeof SavedCriteriaCreate>;
type CriteriaPayload = Omit<SavedCriteria, 'id' | 'name' | 'createdAt' | 'updatedAt'>;

interface CriteriaRow {
  id: string;
  name: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * Saved search criteria: filters, extensions, providers, budget, generation settings and input text.
 * Saving and restoring only stores and returns settings; nothing here submits a job or query.
 */
@Injectable()
export class CriteriaService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  list(): SavedCriteria[] {
    return this.db
      .all<CriteriaRow>('SELECT * FROM saved_criteria ORDER BY name COLLATE NOCASE, created_at')
      .map(toCriteria);
  }

  get(id: string): SavedCriteria {
    const row = this.db.get<CriteriaRow>('SELECT * FROM saved_criteria WHERE id = ?', [id]);
    if (!row) throw AppError.notFound('Saved criteria');
    return toCriteria(row);
  }

  create(body: CriteriaInput): SavedCriteria {
    requireName(body.name);
    const id = randomUUID();
    const now = this.clock.iso();
    this.db.run('INSERT INTO saved_criteria (id, name, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      body.name,
      json.stringify(payloadOf(body)),
      now,
      now,
    ]);
    return this.get(id);
  }

  replace(id: string, body: CriteriaInput): SavedCriteria {
    this.get(id);
    requireName(body.name);
    this.db.run('UPDATE saved_criteria SET name = ?, payload_json = ?, updated_at = ? WHERE id = ?', [
      body.name,
      json.stringify(payloadOf(body)),
      this.clock.iso(),
      id,
    ]);
    return this.get(id);
  }

  delete(id: string) {
    this.get(id);
    this.db.run('DELETE FROM saved_criteria WHERE id = ?', [id]);
  }
}

/** The contract allows any string; a blank name cannot be told apart in lists. */
function requireName(name: string) {
  if (!name.trim()) throw AppError.invalid('Criteria name must not be empty', [{ path: 'body.name', message: 'Required' }]);
}

function payloadOf(body: CriteriaInput): CriteriaPayload {
  return {
    filter: body.filter ?? null,
    extensions: body.extensions ?? [],
    providerIds: body.providerIds ?? [],
    budget: body.budget ?? null,
    generation: body.generation ?? null,
    input: body.input ?? null,
  };
}

function toCriteria(row: CriteriaRow): SavedCriteria {
  const payload = json.parse<Partial<CriteriaPayload>>(row.payload_json, {});
  return {
    id: row.id,
    name: row.name,
    filter: payload.filter ?? null,
    extensions: payload.extensions ?? [],
    providerIds: payload.providerIds ?? [],
    budget: payload.budget ?? null,
    generation: payload.generation ?? null,
    input: payload.input ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
