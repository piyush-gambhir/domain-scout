import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestApplicationOptions } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX } from '@domain-scout/contracts';
import { AppModule } from './app.module.js';
import type { AppConfig } from './core/config.js';
import type { CoreOptions } from './core/core.module.js';
import { ActivityMonitor } from './runtime/activity.js';
import { requestContextMiddleware } from './runtime/http.middleware.js';


export function appOptions(config: AppConfig): NestApplicationOptions {
  return {
    logger: config.embedded ? false : ['error', 'warn'],
    bodyParser: false,


    abortOnError: false,

    forceCloseConnections: true,
  };
}


export function configureApp(app: NestExpressApplication, config: AppConfig): void {

  app.use(requestContextMiddleware(config));
  app.use(app.get(ActivityMonitor).middleware());
  app.useBodyParser('json', { limit: '25mb' });
  app.setGlobalPrefix(API_PREFIX.replace(/^\//, ''));
  app.disable('x-powered-by');
}


export async function createApp(options: CoreOptions): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(options), appOptions(options.config));
  configureApp(app, options.config);
  return app;
}
