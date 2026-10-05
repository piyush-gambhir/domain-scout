import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from './app.factory.js';
import { packageVersion, type AppConfig } from './core/config.js';
import { parseBackendArgs, USAGE, UsageError, type BackendArgs } from './runtime/cli.js';
import { ensureOwnerOnlyDir } from './runtime/files.js';
import { acquireInstanceLock, LockHeldError, type InstanceLock } from './runtime/lock.js';
import { runtimePaths } from './runtime/paths.js';
import { backendUrl, readRuntimeFile, removeRuntimeFile, writeRuntimeFile } from './runtime/runtime-file.js';
import { ShutdownCoordinator } from './runtime/shutdown.js';
import { loadOrCreateApiToken } from './runtime/token.js';

// Exit codes shared with the Go CLI contract: 2 invalid usage, 5 backend setup failure.
const EXIT_USAGE = 2;
const EXIT_SETUP = 5;
/** Upper bound for app.close() after the stop hooks; a stuck close must not leave a zombie backend. */
const CLOSE_TIMEOUT_MS = 10_000;

function stderr(message: string) {
  process.stderr.write(`${message}\n`);
}

function parseArgsOrExit(): BackendArgs {
  try {
    return parseBackendArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr(`domain-scout-backend: ${error.message}\n\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }
}

async function main() {
  const args = parseArgsOrExit();
  const paths = runtimePaths(args.dataDir);
  ensureOwnerOnlyDir(paths.dataDir);
  ensureOwnerOnlyDir(paths.runtimeDir);

  const instanceId = randomUUID();
  let lock: InstanceLock;
  try {
    lock = acquireInstanceLock(paths.lockFile, instanceId);
  } catch (error) {
    if (!(error instanceof LockHeldError)) throw error;
    const running = readRuntimeFile(paths.runtimeFile);
    stderr(`domain-scout-backend: ${error.message}${running ? ` at ${running.url}` : ''}`);
    process.exit(EXIT_SETUP);
  }

  const config: AppConfig = {
    dataDir: paths.dataDir,
    runtimeDir: paths.runtimeDir,
    host: args.host,
    port: args.port,
    webOrigins: args.webOrigins,
    version: packageVersion(),
    instanceId,
    startedAt: new Date().toISOString(),
    embedded: false,
    apiToken: loadOrCreateApiToken(paths.tokenFile),
  };

  let app: NestExpressApplication | undefined;
  try {
    app = await createApp({ config });
    await app.listen(args.port, args.host);
  } catch (error) {
    await app?.close().catch(() => undefined);
    lock.release();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      stderr(
        `domain-scout-backend: port ${args.port} on ${args.host} is already in use by another process. ` +
          'Domain Scout did not connect to it. Choose another port with --port or DOMAIN_SCOUT_PORT.',
      );
      process.exit(EXIT_SETUP);
    }
    if (code === 'EACCES' || code === 'EADDRNOTAVAIL') {
      stderr(`domain-scout-backend: cannot listen on ${args.host}:${args.port} (${code})`);
      process.exit(EXIT_SETUP);
    }
    throw error;
  }

  const port = (app.getHttpServer().address() as AddressInfo).port;
  config.port = port;
  const url = backendUrl(args.host, port);
  writeRuntimeFile(paths.runtimeFile, {
    url,
    pid: process.pid,
    instanceId,
    version: config.version,
    startedAt: config.startedAt,
    dataDir: paths.dataDir,
  });

  const removeRuntimeState = () => {
    removeRuntimeFile(paths.runtimeFile, instanceId);
    lock.release();
  };
  // Covers crashes and process.exit paths; both calls are synchronous and idempotent.
  process.on('exit', removeRuntimeState);

  const coordinator = app.get(ShutdownCoordinator);
  const running = app;
  coordinator.setExitHandler(async (reason) => {
    setTimeout(() => {
      stderr('domain-scout-backend: close timed out; exiting');
      process.exit(1);
    }, CLOSE_TIMEOUT_MS).unref();
    try {
      await running.close();
    } catch (error) {
      stderr(`domain-scout-backend: error while closing: ${(error as Error).message}`);
    }
    removeRuntimeState();
    stderr(`Domain Scout backend stopped (${reason})`);
    process.exit(0);
  });

  let signalCount = 0;
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) {
    process.on(signal, () => {
      signalCount++;
      if (signalCount > 1) {
        stderr('domain-scout-backend: second signal, exiting without waiting');
        process.exit(130);
      }
      void coordinator.stop(signal);
    });
  }

  stderr(`Domain Scout backend listening on ${url} (data directory ${paths.dataDir})`);
}

await main();
