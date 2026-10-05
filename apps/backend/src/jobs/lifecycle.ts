import { Injectable, Logger } from '@nestjs/common';
import type { Job } from '@domain-scout/contracts';

/** Terminal-state listeners. Notified after the state change is committed, outside any transaction. */
@Injectable()
export class JobLifecycleHub {
  private readonly logger = new Logger('JobLifecycle');
  private readonly listeners = new Set<(job: Job) => void>();

  onFinished(listener: (job: Job) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(job: Job) {
    for (const listener of [...this.listeners]) {
      try {
        listener(job);
      } catch (error) {
        this.logger.error(`Job listener failed for ${job.id}: ${(error as Error).message}`);
      }
    }
  }
}
