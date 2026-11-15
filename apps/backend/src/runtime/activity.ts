import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { Clock } from '../core/clock.js';
import { ShutdownCoordinator } from './shutdown.js';

const CHECK_INTERVAL_MS = 30_000;


export interface Blocker {
  name: string;
  detail: string;
}

interface Probe {
  name: string;

  check: () => string | null;

  blocksRestart: boolean;
}








@Injectable()
export class ActivityMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private inflight = 0;
  private lastActiveAt: number;
  private readonly probes = new Map<symbol, Probe>();
  private timer: NodeJS.Timeout | null = null;
  readonly idleTimeoutMs: number;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly shutdown: ShutdownCoordinator,
  ) {
    this.idleTimeoutMs = config.idleTimeoutMs ?? 0;
    this.lastActiveAt = clock.now().getTime();
  }


  addProbe(
    name: string,
    check: () => string | null,
    options: { blocksRestart?: boolean } = {},
  ): () => void {
    const key = Symbol(name);
    this.probes.set(key, { name, check, blocksRestart: options.blocksRestart ?? true });
    return () => this.probes.delete(key);
  }


  middleware() {
    return (_req: Request, res: Response, next: NextFunction) => {
      this.inflight++;
      this.touch();
      res.once('close', () => {
        this.inflight--;
        this.touch();
      });
      next();
    };
  }






  blockers(purpose: 'idle' | 'restart', ownRequests = 0): Blocker[] {
    const blockers: Blocker[] = [];
    const open = this.inflight - ownRequests;
    if (open > 0)
      blockers.push({
        name: 'requests',
        detail: `${open} open request${open === 1 ? '' : 's'} or event stream${open === 1 ? '' : 's'}`,
      });
    for (const probe of this.probes.values()) {
      if (purpose === 'restart' && !probe.blocksRestart) continue;
      let detail: string | null;
      try {
        detail = probe.check();
      } catch (error) {

        detail = `check failed: ${(error as Error).message}`;
      }
      if (detail) blockers.push({ name: probe.name, detail });
    }
    const web = this.liveWebServer();
    if (web) blockers.push({ name: 'ui', detail: `the UI server at ${web} is running` });
    return blockers;
  }


  check(): boolean {
    if (this.idleTimeoutMs <= 0 || this.shutdown.isStopping) return false;
    const now = this.clock.now().getTime();
    if (this.blockers('idle').length > 0) {
      this.lastActiveAt = now;
      return false;
    }
    if (now - this.lastActiveAt < this.idleTimeoutMs) return false;


    void this.shutdown.stop('idle');
    return true;
  }

  onApplicationBootstrap() {
    if (this.config.embedded || this.idleTimeoutMs <= 0) return;
    this.timer = setInterval(() => this.check(), Math.min(CHECK_INTERVAL_MS, this.idleTimeoutMs));
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private touch() {
    this.lastActiveAt = this.clock.now().getTime();
  }


  private liveWebServer(): string | null {
    let info: { url?: unknown; pid?: unknown };
    try {
      info = JSON.parse(
        readFileSync(join(this.config.runtimeDir, 'web.json'), 'utf8'),
      ) as typeof info;
    } catch {
      return null;
    }
    if (typeof info.pid !== 'number' || info.pid <= 0) return null;
    try {
      process.kill(info.pid, 0);
    } catch (error) {

      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
    }
    return typeof info.url === 'string' ? info.url : `pid ${info.pid}`;
  }
}
