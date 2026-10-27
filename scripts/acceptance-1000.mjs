// Acceptance run for the bulk workflow (PRODUCT.md B04-B08, scenarios 2 and 19) against a local stub
// registry, so no name leaves the machine. Drives the real Go CLI and backend:
//   1. 1,200 .com names scanned through `domain-scout scan`, cancelled at about 30% and resumed;
//   2. a second 1,200-name job interrupted by stopping the backend, restarted and resumed;
//   3. API latency sampled while jobs run; a filtered TXT export checked against the stub's truth.
// Every finished name must be queried exactly once. Requires `pnpm build`.
// Usage: node scripts/acceptance-1000.mjs [--names 1200] [--latency-ms 15]
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, 'apps/cli/bin', process.platform === 'win32' ? 'domain-scout.exe' : 'domain-scout');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const COUNT = arg('names', 1200);
const LATENCY = arg('latency-ms', 15);

// --- Stub registry: every third label has no record, the rest are registered. ---
const requests = new Map();
const isFree = (label) => Number(label.replace(/\D/g, '')) % 3 === 0;
const stub = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? '').replace(/^\/domain\//, '')).toLowerCase();
  requests.set(name, (requests.get(name) ?? 0) + 1);
  setTimeout(() => {
    if (isFree(name.split('.')[0])) {
      res.writeHead(404, { 'Content-Type': 'application/rdap+json' });
      res.end(JSON.stringify({ errorCode: 404, title: 'Not Found', rdapConformance: ['rdap_level_0'] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/rdap+json' });
    res.end(
      JSON.stringify({
        objectClassName: 'domain',
        rdapConformance: ['rdap_level_0'],
        ldhName: name,
        status: ['active'],
        events: [
          { eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' },
          { eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' },
        ],
      }),
    );
  }, LATENCY);
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}/`;

const dataDir = mkdtempSync(join(tmpdir(), 'domain-scout-acceptance-'));
const backendPort = 4900 + randomInt(400);
const env = {
  ...process.env,
  DOMAIN_SCOUT_DATA_DIR: dataDir,
  DOMAIN_SCOUT_PORT: String(backendPort),
  DOMAIN_SCOUT_TEST_RDAP_ROUTES: JSON.stringify({ com: stubUrl }),
};

const results = [];
const metrics = {};
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function run(args, input) {
  const res = spawnSync(cli, args, { env, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0 && res.status !== 3) throw new Error(`domain-scout ${args.join(' ')} exited ${res.status}\n${res.stderr}`);
  return res;
}
const token = () => readFileSync(join(dataDir, 'run', 'api-token'), 'utf8').trim();
async function api(path, init = {}) {
  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${backendPort}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null), ms: performance.now() - started };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]) : null;
};

/** Polls a job, sampling result-page latency, until `until(job)` holds. */
async function follow(jobId, until, latencies) {
  for (;;) {
    const job = (await api(`/jobs/${jobId}`)).body.data;
    const page = await api(`/jobs/${jobId}/results?limit=200&sort=domain`);
    latencies.push(page.ms);
    if (until(job)) return job;
    await sleep(100);
  }
}

/** Subjects finished so far, with the stub's request count for each at this moment. */
async function finishedSnapshot(jobId) {
  const counts = new Map();
  let cursor = null;
  do {
    const page = await api(`/jobs/${jobId}/results?states=finished&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const item of page.body.data) counts.set(item.subject, requests.get(item.subject) ?? 0);
    cursor = page.body.nextCursor;
  } while (cursor);
  return counts;
}

/** Finished names the registry was asked about again after the snapshot. In-flight work that was
 * aborted by the interruption is expected to be retried and is not counted. */
function requeried(snapshot) {
  return [...snapshot].filter(([name, n]) => (requests.get(name) ?? 0) > n);
}

function names(prefix) {
  return Array.from({ length: COUNT }, (_, i) => `${prefix}${String(i + 1).padStart(5, '0')}`).join('\n');
}

async function main() {
  run(['service', 'start', '--port', String(backendPort)]);
  // Pacing is a registry courtesy; the stub needs none, so measure the engine itself.
  await api('/settings', { method: 'PATCH', body: JSON.stringify({ concurrency: { perSource: 8, minSourceIntervalMs: 0 } }) });

  // 1. Cancel at about 30% and resume.
  const latencies = [];
  const t0 = performance.now();
  const first = JSON.parse(run(['scan', '--tlds', 'com', '--label', 'Acceptance A', '-'], names('acca')).stdout).data;
  check('1,200 names accepted without manual splitting', first.counters.total === COUNT, `${first.counters.total} items`);
  const atCancel = await follow(first.id, (j) => j.counters.finished >= COUNT * 0.3, latencies);
  run(['jobs', 'cancel', first.id]);
  const cancelled = await follow(first.id, (j) => ['cancelled', 'completed', 'completed_with_errors'].includes(j.state), latencies);
  check('cancel keeps completed evidence', cancelled.state === 'cancelled' && cancelled.counters.finished >= atCancel.counters.finished, `${cancelled.counters.finished} finished at cancel`);
  const finishedA = await finishedSnapshot(first.id);
  run(['jobs', 'resume', first.id]);
  const done = await follow(first.id, (j) => ['completed', 'completed_with_errors'].includes(j.state), latencies);
  metrics.jobASeconds = Math.round((performance.now() - t0) / 100) / 10;
  check('resume finishes every item', done.counters.finished === COUNT && done.counters.unresolved === 0, `${done.counters.finished}/${COUNT}`);
  const expectedFree = Array.from({ length: COUNT }, (_, i) => i + 1).filter((n) => n % 3 === 0).length;
  check('outcomes match the registry', done.counters.outcomes.no_record === expectedFree && done.counters.outcomes.registered === COUNT - expectedFree, JSON.stringify(done.counters.outcomes));
  const repeatsA = requeried(finishedA);
  check('resume never re-queries a name finished before the cancel', repeatsA.length === 0, `${finishedA.size} finished before, ${repeatsA.length} re-queried`);

  // 2. Stop the backend mid-run, restart, resume.
  const second = JSON.parse(run(['scan', '--tlds', 'com', '--label', 'Acceptance B', '-'], names('accb')).stdout).data;
  await follow(second.id, (j) => j.counters.finished >= COUNT * 0.3, latencies);
  run(['service', 'stop']);
  run(['service', 'start', '--port', String(backendPort)]);
  // run() blocks the event loop, so fetch's pool has not yet seen the old backend close its
  // keep-alive sockets; one I/O turn lets it drop them instead of reusing a reset connection.
  await new Promise((resolve) => setImmediate(resolve));
  const afterRestart = (await api(`/jobs/${second.id}`)).body.data;
  check('a stopped backend marks unfinished work interrupted', afterRestart.state === 'interrupted', `${afterRestart.state}, ${afterRestart.counters.finished} finished`);
  const finishedB = await finishedSnapshot(second.id);
  run(['jobs', 'resume', second.id]);
  const doneB = await follow(second.id, (j) => ['completed', 'completed_with_errors'].includes(j.state), latencies);
  check('restart and resume finish every item', doneB.counters.finished === COUNT, `${doneB.counters.finished}/${COUNT}`);
  const repeatsB = requeried(finishedB);
  check('resume after restart never re-queries a finished name', repeatsB.length === 0, `${finishedB.size} finished before, ${repeatsB.length} re-queried`);

  // 3. Responsiveness and exports.
  metrics.resultsPageMs = { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: percentile(latencies, 100), samples: latencies.length };
  check('result pages stay fast while jobs run (p95 under 250 ms)', metrics.resultsPageMs.p95 < 250, JSON.stringify(metrics.resultsPageMs));
  const txt = run(['export', '--scope', 'job', '--job', first.id, '--format', 'txt']).stdout;
  const exported = txt.split('\n').filter((l) => l && !l.startsWith('#'));
  check('TXT export holds exactly the names with no record', exported.length === expectedFree && exported.every((n) => isFree(n.split('.')[0])), `${exported.length} names`);
  const page = await api(`/jobs/${first.id}/results?outcomes=no_record&limit=1000`);
  check('filtered results count matches', page.body.total === expectedFree, `${page.body.total}`);
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`ERROR ${error.message}`);
} finally {
  spawnSync(cli, ['service', 'stop'], { env });
  stub.close();
  if (!process.argv.includes('--keep')) rmSync(dataDir, { recursive: true, force: true });
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
console.log(JSON.stringify({ names: COUNT, stubLatencyMs: LATENCY, ...metrics }));
if (process.argv.includes('--report')) writeFileSync(join(repo, 'docs', 'acceptance-1000.json'), JSON.stringify({ at: new Date().toISOString(), names: COUNT, ...metrics, checks: results }, null, 2));
process.exit(failed || passed !== results.length ? 1 : 0);
