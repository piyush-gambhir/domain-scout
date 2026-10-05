import type { Database } from '../../src/storage/database.js';

/** Direct inserts into the shared schema so system tests do not depend on other modules' services. */
export function seedJob(
  db: Database,
  job: { id: string; type?: string; state: string; label?: string | null; input?: unknown; createdAt: string; total?: number; unresolved?: number },
) {
  db.run(
    `INSERT INTO jobs (id, type, state, label, input_json, total, unresolved, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      job.id,
      job.type ?? 'registry_scan',
      job.state,
      job.label ?? null,
      JSON.stringify(job.input ?? {}),
      job.total ?? 0,
      job.unresolved ?? 0,
      job.createdAt,
      job.createdAt,
      ['completed', 'completed_with_errors', 'cancelled', 'interrupted'].includes(job.state) ? job.createdAt : null,
    ],
  );
}

export function seedItem(
  db: Database,
  item: { id: string; jobId: string; seq: number; subject: string; unicode?: string; suffix?: string | null; state: string; observationId?: string | null },
) {
  db.run(
    `INSERT INTO job_items (id, job_id, seq, subject, unicode, suffix, operation, target, state, registry_observation_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'registry', '', ?, ?, '2026-10-05T12:00:00.000Z')`,
    [item.id, item.jobId, item.seq, item.subject, item.unicode ?? item.subject, item.suffix ?? null, item.state, item.observationId ?? null],
  );
}

export function seedObservation(db: Database, o: { id: string; kind: string; subject: string; observedAt: string; raw?: boolean }) {
  db.run(
    `INSERT INTO observations (id, kind, subject, suffix, source_id, destination, outcome, observed_at, stale_at, payload_json)
     VALUES (?, ?, ?, 'com', 'test', 'test.example', 'registered', ?, ?, '{}')`,
    [o.id, o.kind, o.subject, o.observedAt, o.observedAt],
  );
  if (o.raw) {
    db.run("INSERT INTO raw_diagnostics (observation_id, content_type, body, created_at) VALUES (?, 'text/plain', 'raw', ?)", [
      o.id,
      o.observedAt,
    ]);
  }
}

export function count(db: Database, table: string, where = '1 = 1', params: string[] = []): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params)?.n ?? 0;
}
