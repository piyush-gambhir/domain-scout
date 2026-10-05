import type { ModuleRef } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CapabilitiesResponse } from '@domain-scout/contracts';
import type { CoverageReader, NameCheckCatalog, ProviderDirectory } from '../../src/core/ports.js';
import { OperationRegistry } from '../../src/jobs/operation-registry.js';
import type { OperationHandler } from '../../src/jobs/operation.js';
import { CapabilitiesService } from '../../src/system/capabilities.service.js';
import { createTestApp, type TestApp } from '../helpers.js';

const noPorts = { get: () => { throw new Error('not provided'); } } as unknown as ModuleRef;
const handler = (operation: OperationHandler['operation']) =>
  ({ operation, sourceKey: () => null, destination: () => null, execute: async () => ({ outcome: 'x', resolved: true, evidence: [] }) }) as OperationHandler;

describe('capabilities', () => {
  it('falls back to zeros and empty lists when no module provides the ports', () => {
    const caps = new CapabilitiesService(noPorts, new OperationRegistry()).get();
    expect(caps).toMatchObject({
      registry: { tested: 0, discovered: 0, unsupported: 0, protocols: ['rdap', 'whois'] },
      providers: [],
      jobTypes: [],
      nameCheckServices: [],
      diagnostics: [],
      exportFormats: ['txt', 'csv', 'json'],
      mcp: false,
    });
  });

  it('reports ports and registered handlers when present', () => {
    const operations = new OperationRegistry();
    operations.register(handler('registry'));
    operations.register(handler('diagnostic'));
    const coverage = { counts: () => ({ tested: 3, discovered: 900, unsupported: 12 }) } as CoverageReader;
    const providers = { summary: () => [{ id: 'porkbun', name: 'Porkbun', readiness: 'keyless' as const }] } as unknown as ProviderDirectory;
    const nameChecks = {
      services: () => [
        { id: 'github', name: 'GitHub', namespace: 'login', supported: true, destination: 'api.github.com', reason: null },
        { id: 'x', name: 'X', namespace: 'handle', supported: false, destination: null, reason: 'No public API' },
      ],
    } as NameCheckCatalog;
    const caps = new CapabilitiesService(noPorts, operations, coverage, providers, nameChecks).get();
    expect(caps.registry).toMatchObject({ tested: 3, discovered: 900, unsupported: 12 });
    expect(caps.providers).toEqual([{ id: 'porkbun', name: 'Porkbun', readiness: 'keyless' }]);
    expect(caps.jobTypes).toEqual(['registry_scan', 'diagnostics', 'watch']);
    expect(caps.nameCheckServices).toEqual(['github']);
    expect(caps.diagnostics).toEqual(['dns', 'nameservers', 'dnssec', 'tls', 'http']);
  });

  describe('GET /capabilities', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(() => t.close());

    it('matches the contract with whatever modules are present', async () => {
      const res = await t.api.get('/capabilities').expect(200);
      expect(() => CapabilitiesResponse.parse(res.body)).not.toThrow();
    });
  });
});
