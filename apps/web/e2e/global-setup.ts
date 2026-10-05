import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/*
 * Starts an isolated backend and web server for the run:
 * - backend: node apps/backend/dist/main.js --data-dir <tmp> --port <random> --web-origin <web>
 * - web: next start (or next dev with DS_E2E_NEXT=dev) with DOMAIN_SCOUT_BACKEND_URL pointing at it
 * Then exchanges a bootstrap code (API token from <dataDir>/run/api-token) through the browser at
 * /auth/bootstrap and saves the session cookies as Playwright storage state.
 * Tests read DS_E2E_WEB_URL, DS_E2E_STORAGE and DS_E2E_SESSION from the environment.
 */

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(webDir, '../..');
const backendMain = path.join(repoRoot, 'apps/backend/dist/main.js');
const stateDir = path.join(webDir, '.e2e');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port'))));
    });
  });
}

async function waitFor(url: string, timeoutMs: number, child: ChildProcess, name: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode}; see ${stateDir}/${name}.log`);
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${name} did not become ready at ${url} (${lastError}); see ${stateDir}/${name}.log`);
}

function start(name: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const log = createWriteStream(path.join(stateDir, `${name}.log`));
  const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  return child;
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export default async function globalSetup() {
  if (!existsSync(backendMain)) {
    throw new Error(`Backend build missing at ${backendMain}. Run: pnpm turbo run build --filter @domain-scout/backend`);
  }
  const mode = process.env.DS_E2E_NEXT === 'dev' ? 'dev' : 'start';
  if (mode === 'start' && !existsSync(path.join(webDir, '.next/BUILD_ID'))) {
    throw new Error('Web build missing. Run: pnpm --filter @domain-scout/web build (or set DS_E2E_NEXT=dev)');
  }

  await mkdir(stateDir, { recursive: true });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ds-e2e-'));
  const backendPort = await freePort();
  const webPort = await freePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;

  const backend = start('backend', [backendMain, '--data-dir', dataDir, '--port', String(backendPort), '--web-origin', webUrl], {
    cwd: path.join(repoRoot, 'apps/backend'),
    env: { ...process.env, DOMAIN_SCOUT_PORT: String(backendPort) },
  });
  let web: ChildProcess | undefined;

  const teardown = async () => {
    await stop(web);
    await stop(backend);
    await rm(dataDir, { recursive: true, force: true });
  };

  try {
    await waitFor(`${backendUrl}/api/v1/health`, 30_000, backend, 'backend');

    const nextBin = createRequire(path.join(webDir, 'package.json')).resolve('next/dist/bin/next');
    web = start('web', [nextBin, mode, '--hostname', '127.0.0.1', '--port', String(webPort)], {
      cwd: webDir,
      env: { ...process.env, DOMAIN_SCOUT_BACKEND_URL: backendUrl, NEXT_TELEMETRY_DISABLED: '1' },
    });
    await waitFor(`${webUrl}/session`, mode === 'dev' ? 120_000 : 30_000, web, 'web');

    // Session bootstrap through the real browser flow. If the backend has no auth yet, run without one.
    const storagePath = path.join(stateDir, 'storage.json');
    let session = 'none';
    await writeFile(storagePath, JSON.stringify({ cookies: [], origins: [] }));
    const token = await readFile(path.join(dataDir, 'run/api-token'), 'utf8').then((t) => t.trim()).catch(() => null);
    if (token) {
      const response = await fetch(`${backendUrl}/api/v1/auth/bootstrap-codes`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) {
        const { data } = (await response.json()) as { data: { code: string } };
        const browser = await chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${webUrl}/auth/bootstrap?code=${encodeURIComponent(data.code)}`);
        await page.waitForURL(/\/(scan|session)/);
        if (new URL(page.url()).pathname === '/scan') {
          await context.storageState({ path: storagePath });
          session = 'cookie';
        }
        await browser.close();
      }
    }

    process.env.DS_E2E_WEB_URL = webUrl;
    process.env.DS_E2E_BACKEND_URL = backendUrl;
    process.env.DS_E2E_STORAGE = storagePath;
    process.env.DS_E2E_SESSION = session;
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
