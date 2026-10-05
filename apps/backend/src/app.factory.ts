import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX } from '@domain-scout/contracts';
import { AppModule } from './app.module.js';
import type { CoreOptions } from './core/core.module.js';

/** Builds the HTTP application. Shared by main.ts and tests so both use the same pipeline. */
export async function createApp(options: CoreOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options), {
    logger: options.config.embedded ? false : ['error', 'warn', 'log'],
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '25mb' });
  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
