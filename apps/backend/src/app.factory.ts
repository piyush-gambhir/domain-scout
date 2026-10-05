import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX } from '@domain-scout/contracts';
import { AppModule } from './app.module.js';
import type { AppConfig } from './core/config.js';
import type { CoreOptions } from './core/core.module.js';
import { requestContextMiddleware } from './runtime/http.middleware.js';

/** Nest options shared by main.ts and the test helper. */
export function appOptions(config: AppConfig): NestApplicationOptions {
  return {
    logger: config.embedded ? false : ['error', 'warn', 'log'],
    bodyParser: false,
    // Throw initialization errors (e.g. an unresolved provider) instead of aborting the process
    // silently, which hides the cause when the logger is off in tests.
    abortOnError: false,
    // Open SSE streams and keep-alive sockets must not hold app.close() open during a stop.
    forceCloseConnections: true,
  };
}

/** Express-level pipeline shared by main.ts and tests. Signals are handled by main.ts, not Nest. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  // Before body parsing: request ids and DNS-rebinding Host checks apply to every request, even 404s.
  app.use(requestContextMiddleware(config));
  app.useBodyParser('json', { limit: '25mb' });
  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  app.disable('x-powered-by');
}

/** Builds the HTTP application. Shared by main.ts and tests so both use the same pipeline. */
export async function createApp(options: CoreOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options), appOptions(options.config));
  configureApp(app, options.config);
  return app;
}
