import { Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InputPreviewer, ProviderDirectory } from '../core/ports.js';

/**
 * Ports implemented by other modules that the engine can run without. Looked up across the whole
 * container on first use rather than constructor-injected: the engine works however the implementing
 * module exports them, and an implementation that itself injects JobSubmitter cannot form a DI cycle.
 */
@Injectable()
export class OptionalPorts {
  private readonly cache = new Map<unknown, unknown>();

  constructor(private readonly moduleRef: ModuleRef) {}

  previewer(): InputPreviewer | null {
    return this.resolve(InputPreviewer as unknown as Type<InputPreviewer>);
  }

  providers(): ProviderDirectory | null {
    return this.resolve(ProviderDirectory as unknown as Type<ProviderDirectory>);
  }

  private resolve<T>(token: Type<T>): T | null {
    const cached = this.cache.get(token) as T | undefined;
    if (cached) return cached;
    try {
      const found = this.moduleRef.get(token, { strict: false }) ?? null;
      if (found) this.cache.set(token, found);
      return found;
    } catch {
      return null;
    }
  }
}
