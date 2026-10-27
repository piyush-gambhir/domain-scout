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

/** Something that keeps the backend running, e.g. `{ name: 'jobs', detail: '2 unfinished jobs' }`. */
export interface Blocker {
  name: string;
  detail: string;
}

interface Probe {
  name: string;
  /** Returns a detail while busy, null when idle. */
  check: () => string | null;
  /** False for state that survives a restart (active watches): it only prevents idle stops. */
  blocksRestart: boolean;
}

/**
 * Stops the backend after `idleTimeoutMs` with nothing to do, so CLI-only use leaves no process
 * behind; the CLI starts it again on its next command. Busy means an open request or event stream,
 * a module probe (unfinished jobs, active watches, session-only credentials) or a live UI server
 * started by `domain-scout ui`. The same blockers, minus active watches (they survive a restart),
 * decide whether a newer CLI may restart an older backend (POST /service/stop-unless-busy).
 */
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

  /** Registers a busy check. Returns an unregister function. */
  addProbe(
    name: string,
    check: () => string | null,
    options: { blocksRestart?: boolean } = {},
  ): () => void {
    const key = Symbol(name);
    this.probes.set(key, { name, check, blocksRestart: options.blocksRestart ?? true });
    return () => this.probes.delete(key);
  }

  /** Express middleware counting open requests, event streams included, until their response closes. */
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

  /**
   * What keeps the backend busy. `restart` skips restart-safe probes; a live UI server blocks both,
   * since `domain-scout ui` may have started the backend for a non-default UI origin.
   * `ownRequests` excludes the caller's own open request.
   */
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
        // A failing check must not stop a backend that may be busy.
        detail = `check failed: ${(error as Error).message}`;
      }
      if (detail) blockers.push({ name: probe.name, detail });
    }
    const web = this.liveWebServer();
    if (web) blockers.push({ name: 'ui', detail: `the UI server at ${web} is running` });
    return blockers;
  }

  /** One idle check: starts a graceful stop once idle for the whole timeout. Returns true when it did. */
  check(): boolean {
    if (this.idleTimeoutMs <= 0 || this.shutdown.isStopping) return false;
    const now = this.clock.now().getTime();
    if (this.blockers('idle').length > 0) {
      this.lastActiveAt = now;
      return false;
    }
    if (now - this.lastActiveAt < this.idleTimeoutMs) return false;
    // Synchronous from the check to isStopping, so a request arriving now is refused as "stopping"
    // (the CLI retries it against a fresh backend) rather than cut off mid-way.
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

  /** URL of the UI server recorded in run/web.json while its process is alive. */
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
      // EPERM: the process exists but belongs to someone else; treat it as alive.
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
    }
    return typeof info.url === 'string' ? info.url : `pid ${info.pid}`;
  }
}
