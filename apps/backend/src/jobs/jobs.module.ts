import { Global, Module, type OnModuleInit } from '@nestjs/common';
import { JobLifecycle, JobResults, JobSubmitter } from '../core/ports.js';
import { ActivityMonitor } from '../runtime/activity.js';
import { Database } from '../storage/database.js';
import { DEFAULT_ENGINE_OPTIONS, JOBS_ENGINE_OPTIONS } from './engine-options.js';
import { JobStore } from './job-store.js';
import { JobOperationsController, JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';
import { JobLifecycleHub } from './lifecycle.js';
import { OptionalPorts } from './optional-ports.js';
import { JobPlanner } from './planner.js';
import { JobResultsService } from './results.service.js';
import { JobScheduler } from './scheduler.js';

/**
 * Jobs engine. Global so every module can submit work (JobSubmitter), react to finished jobs
 * (JobLifecycle) and read results with the shared filter (JobResults).
 */
@Global()
@Module({
  controllers: [JobsController, JobOperationsController],
  providers: [
    { provide: JOBS_ENGINE_OPTIONS, useValue: DEFAULT_ENGINE_OPTIONS },
    OptionalPorts,
    JobStore,
    JobPlanner,
    JobLifecycleHub,
    JobResultsService,
    JobScheduler,
    JobsService,
    { provide: JobSubmitter, useExisting: JobsService },
    { provide: JobLifecycle, useExisting: JobsService },
    { provide: JobResults, useExisting: JobResultsService },
  ],
  exports: [JobsService, JobSubmitter, JobLifecycle, JobResults],
})
export class JobsModule implements OnModuleInit {
  constructor(
    private readonly activity: ActivityMonitor,
    private readonly db: Database,
  ) {}

  /** Unfinished jobs keep the backend running; stopping would interrupt them. */
  onModuleInit() {
    this.activity.addProbe('jobs', () => {
      const n = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued', 'running', 'cancelling')`)?.n ?? 0;
      return n > 0 ? `${n} unfinished job${n === 1 ? '' : 's'}` : null;
    });
  }
}
