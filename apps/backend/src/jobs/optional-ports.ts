import { Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InputPreviewer, ProviderDirectory } from '../core/ports.js';






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
