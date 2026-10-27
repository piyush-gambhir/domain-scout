// `pnpm dev`: build shared packages, run the backend and web in watch mode, then open the UI
// through the same single-use bootstrap exchange the CLI launcher uses.
// Dev state lives in <repo>/.dev-data unless DOMAIN_SCOUT_DATA_DIR is set, so it never touches
// the real application data directory.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DOMAIN_SCOUT_DATA_DIR ?? join(repo, '.dev-data');
const backendPort = Number(process.env.DOMAIN_SCOUT_PORT ?? 4317);
const webPort = Number(process.env.DOMAIN_SCOUT_WEB_PORT ?? 3000);
const backendUrl = `http://127.0.0.1:${backendPort}`;
const webUrl = `http://127.0.0.1:${webPort}`;
const noOpen = process.argv.includes('--no-open');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const build = spawnSync(pnpm, ['turbo', 'run', 'build', '--filter=./packages/*'], {
  cwd: repo,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [];
function start(name, cmd, args, options) {
  const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  child.on('exit', (code) => {
    console.error(`[dev] ${name} exited (${code ?? 'signal'})`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

// The UI dev server is not started by the CLI launcher, so the backend must not stop when idle.
start('backend', process.execPath, ['scripts/dev.mjs', '--data-dir', dataDir, '--port', String(backendPort), '--idle-timeout', '0'], {
  cwd: join(repo, 'apps/backend'),
});
start('web', pnpm, ['exec', 'next', 'dev', '--hostname', '127.0.0.1', '--port', String(webPort)], {
  cwd: join(repo, 'apps/web'),
  env: { ...process.env, DOMAIN_SCOUT_BACKEND_URL: backendUrl },
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (!(await waitFor(`${backendUrl}/api/v1/health`, 60_000))) {
  console.error('[dev] backend did not become healthy');
  shutdown(1);
}
await waitFor(`${webUrl}/`, 120_000);

let url = webUrl;
try {
  const token = readFileSync(join(dataDir, 'run', 'api-token'), 'utf8').trim();
  const res = await fetch(`${backendUrl}/api/v1/auth/bootstrap-codes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) {
    const { data } = await res.json();
    url = `${webUrl}/auth/bootstrap?code=${encodeURIComponent(data.code)}`;
  }
} catch {}

console.error(`[dev] Domain Scout UI: ${url}`);
if (!noOpen) {
  const opener =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();
}
