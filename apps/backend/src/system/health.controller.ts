import { Controller, Inject } from '@nestjs/common';
import { CONTRACT_VERSION, PROTOCOL_VERSION } from '@domain-scout/contracts';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { ApiRoute } from '../core/route.js';
import { ok } from '../core/envelope.js';

@Controller()
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @ApiRoute('getHealth')
  health() {
    return ok({
      status: 'ok' as const,
      instanceId: this.config.instanceId,
      protocolVersion: PROTOCOL_VERSION,
      contractVersion: CONTRACT_VERSION,
      version: this.config.version,
      startedAt: this.config.startedAt,
      pid: process.pid,
      dataDir: this.config.dataDir,
    });
  }
}
