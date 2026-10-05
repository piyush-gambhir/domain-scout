import { Global, Module } from '@nestjs/common';
import { JobLifecycle, JobResults, JobSubmitter } from '../core/ports.js';
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
export class JobsModule {}
