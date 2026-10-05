// Container entry point: runs the backend (loopback only, inside the container) and the web server
// (the only published port), prints a sign-in URL, and stops both gracefully on SIGTERM.
//
//   node container-start.mjs              start everything (Docker CMD)
//   node container-start.mjs --print-url  print a fresh sign-in URL for the running app
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const home = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DOMAIN_SCOUT_DATA_DIR ?? '/data';
const backendPort = Number(process.env.DOMAIN_SCOUT_PORT ?? 4317);
// The port the browser uses on the host; it decides the Origin the backend must accept.
const publicPort = Number(process.env.DOMAIN_SCOUT_PUBLIC_PORT ?? 3000);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const publicUrl = `http://localhost:${publicPort}`;

async function signInUrl() {
  const token = readFileSync(join(dataDir, 'run', 'api-token'), 'utf8').trim();
  const res = await fetch(`${backendUrl}/api/v1/auth/bootstrap-codes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`bootstrap code request failed: HTTP ${res.status}`);
  const { data } = await res.json();
  return { url: `${publicUrl}/auth/bootstrap?code=${encodeURIComponent(data.code)}`, expiresAt: data.expiresAt };
}

if (process.argv.includes('--print-url')) {
  const { url, expiresAt } = await signInUrl();
  console.log(url);
  console.error(`Single use, valid until ${expiresAt}.`);
  process.exit(0);
}

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// A fresh container cannot have a live backend for this volume, but a lock left by the previous
// container can name a pid that is reused here, so clear transient runtime state first.
for (const file of ['backend.lock', 'backend.lock.recover', 'run/backend.json', 'run/web.json']) {
  rmSync(join(dataDir, file), { force: true, recursive: true });
}

const origins = [`http://localhost:${publicPort}`, `http://127.0.0.1:${publicPort}`];
const backend = spawn(
  process.execPath,
  [
    join(home, 'lib/backend/dist/main.js'),
    '--data-dir', dataDir,
    '--port', String(backendPort),
    ...origins.flatMap((o) => ['--web-origin', o]),
  ],
  { stdio: 'inherit', env: { ...process.env, DOMAIN_SCOUT_BOOTSTRAP_TTL_SECONDS: process.env.DOMAIN_SCOUT_BOOTSTRAP_TTL_SECONDS ?? '900' } },
);

let web;
let stopping = false;

async function stop(code) {
  if (stopping) return;
  stopping = true;
  web?.kill('SIGTERM');
  try {
    const token = readFileSync(join(dataDir, 'run', 'api-token'), 'utf8').trim();
    await fetch(`${backendUrl}/api/v1/service/stop`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    backend.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 10_000).unref();
  backend.once('exit', () => process.exit(code));
}

backend.on('exit', (code) => {
  if (!stopping) {
    console.error(`[domain-scout] backend exited (${code}); stopping`);
    stop(code || 1);
  }
});
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

if (!(await waitFor(`${backendUrl}/api/v1/health`, 60_000))) {
  console.error('[domain-scout] backend did not become healthy');
  await stop(1);
}

web = spawn(process.execPath, [join(home, 'lib/web/server.js')], {
  stdio: 'inherit',
  env: { ...process.env, HOSTNAME: '0.0.0.0', PORT: '3000', DOMAIN_SCOUT_BACKEND_URL: backendUrl, NODE_ENV: 'production' },
});
web.on('exit', (code) => {
  if (!stopping) {
    console.error(`[domain-scout] web server exited (${code}); stopping`);
    stop(code || 1);
  }
});

await waitFor('http://127.0.0.1:3000/', 60_000);
try {
  const { url, expiresAt } = await signInUrl();
  console.log(`\n  Domain Scout is running.\n\n  Open: ${url}\n  (single use, valid until ${expiresAt})\n\n  New link any time: docker compose exec domain-scout open-url\n`);
} catch (error) {
  console.error(`[domain-scout] could not create a sign-in link: ${error.message}`);
}
