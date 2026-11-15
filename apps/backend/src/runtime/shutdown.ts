import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../core/config.js';
import { Database } from '../storage/database.js';

export const DEFAULT_STOP_GRACE_MS = 5_000;

const CLEANUP_AFTER_ABORT_MS = 1_000;

export interface StopContext {
  reason: string;
  graceMs: number;

  deadline: number;

  signal: AbortSignal;
}

export type StoppingHook = (ctx: StopContext) => void | Promise<void>;








@Injectable()
export class ShutdownCoordinator implements OnModuleDestroy {
  private readonly logger = new Logger('Shutdown');
  private readonly hooks = new Map<symbol, { name: string; hook: StoppingHook }>();
  private exitHandler: ((reason: string) => Promise<void>) | null = null;
  private hooksRun: Promise<void> | null = null;
  private stopRun: Promise<void> | null = null;
  readonly graceMs: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly db: Database,
  ) {
    this.graceMs = config.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }


  get isStopping(): boolean {
    return this.hooksRun !== null;
  }


  onStopping(hook: StoppingHook, name = 'hook'): () => void {
    const key = Symbol(name);
    this.hooks.set(key, { name, hook });
    return () => this.hooks.delete(key);
  }


  setExitHandler(handler: (reason: string) => Promise<void>): void {
    this.exitHandler = handler;
  }


  stop(reason: string): Promise<void> {
    this.stopRun ??= (async () => {
      await this.runHooks(reason);
      try {
        this.db.checkpoint();
      } catch (error) {
        this.logger.warn(`SQLite checkpoint failed: ${(error as Error).message}`);
      }
      if (this.exitHandler) await this.exitHandler(reason);
    })();
    return this.stopRun;
  }


  async onModuleDestroy() {
    await this.runHooks('close');
  }

  private runHooks(reason: string): Promise<void> {
    this.hooksRun ??= this.executeHooks(reason);
    return this.hooksRun;
  }

  private async executeHooks(reason: string): Promise<void> {
    const controller = new AbortController();
    const deadline = Date.now() + this.graceMs;
    const ctx: StopContext = { reason, graceMs: this.graceMs, deadline, signal: controller.signal };
    const all = Promise.allSettled(
      [...this.hooks.values()].map(async ({ name, hook }) => {
        try {
          await hook(ctx);
        } catch (error) {
          this.logger.error(`Stopping hook ${name} failed: ${(error as Error).message}`);
        }
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    const graceExpired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.graceMs);
    });
    const first = await Promise.race([all.then(() => 'done' as const), graceExpired]);
    clearTimeout(timer);
    if (first === 'done') return;
    controller.abort(new Error('Stop grace period elapsed'));
    let cleanupTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, CLEANUP_AFTER_ABORT_MS);
      }),
    ]);
    clearTimeout(cleanupTimer);
  }
}
