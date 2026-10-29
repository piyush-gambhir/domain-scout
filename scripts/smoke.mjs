// End-to-end smoke test: one local backend driven by the Go CLI, the HTTP API and the web UI.
// Checks that every interface sees the same job and evidence, that a restart keeps state, and
// that the browser session flow works. Sends only the fixed live test set to registry RDAP servers.
// Requires `pnpm build`. Usage: node scripts/smoke.mjs [--keep]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, 'apps/cli/bin', process.platform === 'win32' ? 'domain-scout.exe' : 'domain-scout');
const dataDir = mkdtempSync(join(tmpdir(), 'domain-scout-smoke-'));
const backendPort = 4400 + randomInt(500);
const webPort = 3400 + randomInt(500);
const env = { ...process.env, DOMAIN_SCOUT_DATA_DIR: dataDir, DOMAIN_SCOUT_PORT: String(backendPort) };
const gibberish = Array.from({ length: 24 }, () => String.fromCharCode(97 + randomInt(26))).join('');
const expected = {
  'example.com': 'registered',
  'google.com': 'registered',
  'nic.si': 'registered',
  'bbc.co.uk': 'registered',
  [`${gibberish}.com`]: 'no_record',
  [`${gibberish}.si`]: 'no_record',
};

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function run(args, { allowFail = false } = {}) {
  const res = spawnSync(cli, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`domain-scout ${args.join(' ')} exited ${res.status}\n${res.stderr}`);
  }
  return res;
}

const token = () => readFileSync(join(dataDir, 'run', 'api-token'), 'utf8').trim();
const api = async (path, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${backendPort}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const outcomes = (items) => Object.fromEntries(items.map((i) => [i.subject, i.outcome]));

async function main() {
  for (const required of [cli, join(repo, 'apps/backend/dist/main.js'), join(repo, 'apps/web/.next/BUILD_ID')]) {
    if (!existsSync(required)) throw new Error(`Missing ${required}. Run \`pnpm build\` first.`);
  }
  console.log(`data dir ${dataDir}, backend :${backendPort}, web :${webPort}`);

  // 1. The CLI launcher starts the backend and the web UI and hands out a sign-in link.
  const ui = run(['ui', '--no-open', '--web-port', String(webPort)]);
  const signIn = ui.stderr.match(/https?:\/\/\S+\/auth\/bootstrap\?code=\S+/)?.[0];
  check('cli ui starts backend and web and prints a sign-in link', Boolean(signIn));

  // 2. A registry scan through the CLI, waiting for completion.
  const scan = run(['scan', ...Object.keys(expected), '--wait']);
  const cliItems = JSON.parse(scan.stdout).data;
  const cliOutcomes = outcomes(cliItems);
  check('cli scan classifies the fixed live set', JSON.stringify(cliOutcomes) === JSON.stringify({ ...cliOutcomes, ...expected }), JSON.stringify(cliOutcomes));
  const jobId = cliItems[0]?.jobId;

  // 3. The HTTP API (what the web forwards to) sees the same job and evidence.
  const viaApi = await api(`/jobs/${jobId}/results?limit=100`);
  check('api returns the same outcomes as the cli', JSON.stringify(outcomes(viaApi.body.data)) === JSON.stringify(cliOutcomes));
  const evidence = await api('/domains/nic.si/evidence');
  check('domain evidence names the registry source', evidence.body?.data?.registry?.[0]?.source?.destination?.includes('register.si') === true);

  // 4. Browser session flow through the web server, then the same results via its /api/v1 forwarder.
  const boot = await fetch(signIn, { redirect: 'manual' });
  const cookies = (boot.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  check('bootstrap sets the session cookies and redirects', boot.status === 303 && cookies.includes('ds_session=') && cookies.includes('ds_csrf='));
  const viaWeb = await fetch(`http://127.0.0.1:${webPort}/api/v1/jobs/${jobId}/results?limit=100`, { headers: { cookie: cookies } });
  const webBody = await viaWeb.json();
  check('web forwarder returns the same outcomes', viaWeb.status === 200 && JSON.stringify(outcomes(webBody.data)) === JSON.stringify(cliOutcomes));
  const reused = await fetch(signIn, { redirect: 'manual' });
  check('sign-in links are single use', reused.status !== 303 || !(reused.headers.get('location') ?? '').endsWith('/scan'));
  const noSession = await fetch(`http://127.0.0.1:${webPort}/api/v1/settings`);
  check('api through the web requires a session', noSession.status === 401);

  // 5. Shortlist and a scoped export through the CLI match the scan.
  const list = JSON.parse(run(['shortlist', 'create', 'Smoke']).stdout).data;
  run(['shortlist', 'add', list.id, 'nic.si', `${gibberish}.si`]);
  const csv = run(['export', '--scope', 'collection', '--shortlist', list.id, '--format', 'csv']).stdout;
  const csvDomains = csv.split('\r\n').slice(1).filter(Boolean).map((row) => row.split(',')[0]);
  check('shortlist export contains exactly its entries', csvDomains.sort().join(',') === ['nic.si', `${gibberish}.si`].sort().join(','), csvDomains.join(','));
  const txt = run(['export', '--scope', 'job', '--job', jobId, '--format', 'txt']).stdout;
  const names = txt.split('\n').filter((l) => l && !l.startsWith('#'));
  check('txt export defaults to candidates (no registry record)', names.sort().join(',') === [`${gibberish}.com`, `${gibberish}.si`].sort().join(','), names.join(','));

  // 6. Restart the backend: jobs, evidence and shortlists survive; the browser session too.
  run(['service', 'stop']);
  run(['service', 'start', '--port', String(backendPort)]);
  // run() blocks the event loop, so fetch's pool has not yet seen the old backend close its
  // keep-alive sockets; one I/O turn lets it drop them instead of reusing a reset connection.
  await new Promise((resolve) => setImmediate(resolve));
  const afterRestart = await api(`/jobs/${jobId}/results?limit=100`);
  check('results survive a backend restart', JSON.stringify(outcomes(afterRestart.body.data)) === JSON.stringify(cliOutcomes));
  const entries = await api(`/collections/${list.id}/entries`);
  check('shortlist survives a backend restart', entries.body?.data?.length === 2);
  const session = await fetch(`http://127.0.0.1:${webPort}/api/v1/auth/session`, { headers: { cookie: cookies } });
  check('browser session survives a backend restart', session.status === 200);

  // 7. Usage errors are machine-readable and exit 2 without prompting.
  const bad = run(['data', 'delete', '--categories', 'jobs'], { allowFail: true });
  check('destructive commands refuse without --yes (exit 2)', bad.status === 2 && bad.stdout === '');
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(`ERROR ${error.message}`);
} finally {
  run(['service', 'stop'], { allowFail: true });
  try {
    const web = JSON.parse(readFileSync(join(dataDir, 'run', 'web.json'), 'utf8'));
    if (web.pid) process.kill(web.pid);
  } catch {}
  if (!process.argv.includes('--keep')) rmSync(dataDir, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(failed || passed !== results.length ? 1 : 0);
