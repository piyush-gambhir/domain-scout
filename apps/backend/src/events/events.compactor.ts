import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { EventsService } from './events.service.js';

const COMPACT_INTERVAL_MS = 60 * 60 * 1000;

/** Compacts transient events on startup and hourly. The timer is unref'd so it never keeps the process alive. */
@Injectable()
export class EventsCompactor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Events');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly events: EventsService) {}

  onApplicationBootstrap() {
    this.run();
    this.timer = setInterval(() => this.run(), COMPACT_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private run() {
    try {
      this.events.compact();
    } catch (error) {
      this.logger.warn(`Event compaction failed: ${(error as Error).message}`);
    }
  }
}
