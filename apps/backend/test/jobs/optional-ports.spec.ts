import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { InputPreviewer, ProviderDirectory } from '../../src/core/ports.js';
import { OptionalPorts } from '../../src/jobs/optional-ports.js';
import { fakeDirectory, fakePreviewer } from './helpers.js';

const previewer = fakePreviewer();

/** Implements a port without exporting it and without being global, as a feature module might. */
@Module({ providers: [{ provide: InputPreviewer, useValue: previewer }] })
class HiddenPreviewerModule {}

@Module({ providers: [OptionalPorts], exports: [OptionalPorts] })
class EngineModule {}

describe('optional ports', () => {
  it('finds an implementation anywhere in the container and tolerates a missing one', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EngineModule, HiddenPreviewerModule] }).compile();
    const ports = moduleRef.get(OptionalPorts);
    expect(ports.previewer()).toBe(previewer);
    expect(ports.providers()).toBeNull();
    await moduleRef.close();

    const directory = fakeDirectory(['porkbun']);
    const withDirectory = await Test.createTestingModule({
      imports: [EngineModule],
      providers: [{ provide: ProviderDirectory, useValue: directory }],
    }).compile();
    expect(withDirectory.get(OptionalPorts).providers()).toBe(directory);
    expect(withDirectory.get(OptionalPorts).previewer()).toBeNull();
    await withDirectory.close();
  });
});
