import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createApp } from './app.factory.js';
import { packageVersion, type AppConfig } from './core/config.js';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '4317' },
    'web-origin': { type: 'string', multiple: true },
  },
});

const dataDir = values['data-dir'] ?? join(process.cwd(), '.domain-scout');
const config: AppConfig = {
  dataDir,
  runtimeDir: join(dataDir, 'run'),
  host: values.host!,
  port: Number(values.port),
  webOrigins: values['web-origin'] ?? ['http://127.0.0.1:3000', 'http://localhost:3000'],
  version: packageVersion(),
  instanceId: randomUUID(),
  startedAt: new Date().toISOString(),
  embedded: false,
};

const app = await createApp({ config });
await app.listen(config.port, config.host);
console.error(`Domain Scout backend listening on http://${config.host}:${config.port}`);
