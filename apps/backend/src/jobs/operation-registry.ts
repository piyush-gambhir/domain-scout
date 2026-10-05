import { Injectable } from '@nestjs/common';
import type { JobOperation } from '@domain-scout/contracts';
import type { OperationHandler } from './operation.js';

/** Modules register their handlers in onModuleInit; the jobs engine looks them up per item. */
@Injectable()
export class OperationRegistry {
  private readonly handlers = new Map<JobOperation, OperationHandler>();

  register(handler: OperationHandler) {
    if (this.handlers.has(handler.operation)) {
      throw new Error(`Duplicate handler for operation ${handler.operation}`);
    }
    this.handlers.set(handler.operation, handler);
  }

  get(operation: JobOperation): OperationHandler | undefined {
    return this.handlers.get(operation);
  }

  operations(): JobOperation[] {
    return [...this.handlers.keys()];
  }
}
