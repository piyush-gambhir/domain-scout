import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NameCheckServiceListResponse } from '@domain-scout/contracts';
import { NameCheckCatalog } from '../../src/core/ports.js';
import { OperationRegistry } from '../../src/jobs/operation-registry.js';
import { EnrichmentModule } from '../../src/enrichment/enrichment.module.js';
import { DiagnosticHandler } from '../../src/enrichment/diagnostic.handler.js';
import { NameCheckHandler } from '../../src/enrichment/name-check.handler.js';
import { createModuleApp, type ModuleApp } from '../evidence/harness.js';
import { ctx, item } from './fakes.js';

describe('EnrichmentModule', () => {
  let t: ModuleApp;
  const networkSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network access in a unit test'));
  beforeAll(async () => {
    t = await createModuleApp({ modules: [EnrichmentModule] });
  });
  afterAll(async () => {
    await t.close();
    expect(networkSpy).not.toHaveBeenCalled();
    networkSpy.mockRestore();
  });

  it('registers the name_check and diagnostic handlers', () => {
    const registry = t.get(OperationRegistry);
    expect(registry.get('name_check')).toBeInstanceOf(NameCheckHandler);
    expect(registry.get('diagnostic')).toBeInstanceOf(DiagnosticHandler);
  });

  it('exports NameCheckCatalog globally with supported and unsupported services', () => {
    const services = t.app.get(NameCheckCatalog).services();
    expect(services.filter((s) => s.supported).map((s) => s.id)).toEqual(['github', 'npm', 'pypi', 'crates']);
    expect(services.filter((s) => !s.supported)).toHaveLength(6);
  });

  it('lists the services over HTTP without contacting any of them', async () => {
    const res = await request(t.app.getHttpServer()).get('/api/v1/name-checks/services').expect(200);
    const services = NameCheckServiceListResponse.parse(res.body).data;
    expect(services).toHaveLength(10);
    expect(services.find((s) => s.id === 'x')).toMatchObject({ supported: false, destination: null });
    expect(services.find((s) => s.id === 'x')!.reason).toBeTruthy();
  });

  it('wires the diagnostic handler to settings for the default resolver', async () => {
    const handler = t.get(OperationRegistry).get('diagnostic')!;
    const dnssec = item('diagnostic', 'example.com', 'dnssec');
    // Default settings use the system resolver, which cannot report DNSSEC validation: no request is made.
    expect(handler.sourceKey(dnssec)).toBeNull();
    expect(await handler.execute(dnssec, ctx())).toMatchObject({ outcome: 'error', error: { code: 'unsupported_resolver' } });
  });
});
