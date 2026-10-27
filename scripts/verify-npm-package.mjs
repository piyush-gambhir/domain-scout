// Installs the packed npm tarballs (release/npm, from scripts/package-npm.mjs) into a temporary
// global prefix without touching the registry, then checks the installed CLI end to end: the
// launcher script, the bundled backend started with this Node.js, exit codes, MCP over stdio,
// signal handling, idle shutdown and the missing-UI message. No domain names are sent anywhere.
// Usage: node scripts/verify-npm-package.mjs [--tarballs DIR]
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const i = process.argv.indexOf('--tarballs');
const tarballs = i > 0 ? process.argv[i + 1] : join(repo, 'release', 'npm');
const win = process.platform === 'win32';
const target = `${process.platform}-${process.arch}`;
const files = readdirSync(tarballs);
const mainTgz = files.find((f) => /^domain-scout-\d.*\.tgz$/.test(f));
const platformTgz = files.find((f) => f.startsWith(`domain-scout-cli-${target}-`) && f.endsWith('.tgz'));
if (!mainTgz || !platformTgz) {
  console.error(`Missing tarballs for ${target} in ${tarballs}. Run node scripts/package-npm.mjs first.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'ds-npm-verify-'));
const prefix = join(work, 'prefix');
const dataDir = join(work, 'data');
const port = 5600 + randomInt(300);
const results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// Windows runs .cmd shims (npm, the installed domain-scout) only through a shell: quote for cmd.exe.
const quote = (arg) => (win && /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg);
const shellArgs = (args) => (win ? args.map(quote) : args);
const install = spawnSync(
  win ? 'npm.cmd' : 'npm',
  shellArgs(['install', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', '--loglevel', 'error', join(tarballs, mainTgz), join(tarballs, platformTgz)]),
  { encoding: 'utf8', shell: win },
);
check('npm installs the tarballs offline', install.status === 0, install.status === 0 ? '' : install.stderr.trim().split('\n').slice(-3).join(' | '));
const cli = win ? join(prefix, 'domain-scout.cmd') : join(prefix, 'bin', 'domain-scout');
const env = { ...process.env, DOMAIN_SCOUT_DATA_DIR: dataDir, DOMAIN_SCOUT_PORT: String(port), DOMAIN_SCOUT_IDLE_TIMEOUT: '3' };
// The launcher's `#!/usr/bin/env node` must find the Node.js running this check (e.g. 24 or 26).
env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH}`;
delete env.DOMAIN_SCOUT_NODE;
delete env.DOMAIN_SCOUT_BACKEND_ENTRY;
// Run outside any checkout: the launcher also looks for backend and UI builds above the working directory.
const cwd = work;
const run = (args, extra = {}) => spawnSync(quote(cli), shellArgs(args), { env, cwd, encoding: 'utf8', shell: win, ...extra });

try {
  const version = run(['version']);
  const expected = JSON.parse(readFileSync(join(prefix, win ? '' : 'lib', 'node_modules', 'domain-scout', 'package.json'), 'utf8')).version;
  check('version runs the platform CLI', version.status === 0 && version.stdout.includes(expected), version.stdout.trim().slice(0, 120));

  const coverage = run(['coverage', 'summary']);
  check('first command starts the bundled backend', coverage.status === 0 && coverage.stderr.includes('Starting the Domain Scout backend'), coverage.stderr.trim().split('\n')[0]);
  const info = JSON.parse(readFileSync(join(dataDir, 'run', 'backend.json'), 'utf8'));
  check('backend reports the package version', info.version === expected, info.version);
  if (!win) {
    // /proc where it exists (slim Linux images have no ps), ps elsewhere.
    const proc = `/proc/${info.pid}/cmdline`;
    const ps = existsSync(proc)
      ? readFileSync(proc, 'utf8').split('\0').join(' ').trim()
      : (spawnSync('ps', ['-o', 'command=', '-p', String(info.pid)], { encoding: 'utf8' }).stdout ?? '').trim();
    check('backend runs from the install with this Node.js', ps.startsWith(process.execPath) && ps.includes(join('domain-scout', 'dist', 'main.js')) && ps.includes(prefix), ps.slice(0, 160));
  }

  const usage = run(['data', 'delete', '--categories', 'jobs']);
  check('exit codes pass through (usage error is 2)', usage.status === 2 && usage.stdout === '', `exit ${usage.status}`);

  const ui = run(['ui', '--no-open']);
  check('ui explains that the npm package has no UI', ui.status === 5 && ui.stderr.includes('npm package is CLI-only'), ui.stderr.trim().split('\n').pop());

  // MCP over stdio: one initialize round trip, then end of input ends the server.
  const mcp = spawn(quote(cli), ['mcp'], { env, cwd, shell: win, stdio: ['pipe', 'pipe', 'pipe'] });
  let mcpOut = '';
  mcp.stdout.on('data', (d) => (mcpOut += d));
  mcp.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } })}\n`,
  );
  const answered = await waitFor(() => mcpOut.includes('"id":1'), 10_000);
  mcp.stdin.end();
  const mcpExit = await exitOf(mcp, 10_000);
  check('mcp answers over stdio and exits at end of input', answered && mcpExit.code === 0, `exit ${mcpExit.code ?? mcpExit.signal}`);

  if (!win) {
    const held = spawn(cli, ['mcp'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((r) => setTimeout(r, 1000));
    held.kill('SIGTERM');
    const ended = await exitOf(held, 10_000);
    // 130 is the Go CLI's own exit for SIGTERM, passed back by the launcher: proof the signal reached it.
    check('SIGTERM to the launcher reaches the CLI (exit 130)', ended.code === 130, `${ended.code ?? ended.signal}`);
  }

  // The engine stops itself once idle (3 s here, checked every 3 s).
  const stopped = await waitFor(() => !existsSync(join(dataDir, 'run', 'backend.json')), 20_000);
  check('the backend stops itself when idle', stopped, readFileSync(join(dataDir, 'logs', 'backend.log'), 'utf8').trim().split('\n').pop());
  const again = run(['coverage', 'summary']);
  check('the next command starts it again', again.status === 0 && again.stderr.includes('Starting the Domain Scout backend'));
} finally {
  run(['service', 'stop']);
  // A UI server must never be left behind (the npm package has none, but a failed check might start one).
  try {
    const web = JSON.parse(readFileSync(join(dataDir, 'run', 'web.json'), 'utf8'));
    if (web.pid) process.kill(web.pid);
  } catch {}
  rmSync(work, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed (${target}, Node.js ${process.version})`);
process.exit(passed === results.length ? 0 : 1);

function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

function exitOf(child, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, signal: 'timeout' });
    }, ms);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
