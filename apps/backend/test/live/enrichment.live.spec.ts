import { randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@domain-scout/contracts';
import { DiagnosticHandler } from '../../src/enrichment/diagnostic.handler.js';
import { NameCheckHandler } from '../../src/enrichment/name-check.handler.js';
import { NodeDnsTransport, defaultFetch, nodeHttpProbe, nodeTlsProbe } from '../../src/enrichment/transports.js';
import type { JobItemRecord, OperationContext, OperationResult } from '../../src/jobs/operation.js';
import type { SettingsService } from '../../src/system/settings.service.js';

/**
 * Authorized live checks (docs/IMPLEMENTATION.md "Live network rule"): only names from the fixed test
 * set (example.com, google.com and their labels) and random 24-character gibberish names, sent only
 * to DNS resolvers, the domains' own TLS/HTTP endpoints, GitHub, npm, PyPI and crates.io.
 * Run with DOMAIN_SCOUT_LIVE_TESTS=1.
 */
// Opt in with exactly DOMAIN_SCOUT_LIVE_TESTS=1; any other value (including 0) keeps these skipped.
const live = process.env.DOMAIN_SCOUT_LIVE_TESTS === '1';

const settings: Settings = structuredClone(DEFAULT_SETTINGS);
settings.retries.timeoutMs = 15_000;
const ctx = (): OperationContext => ({ signal: new AbortController().signal, attempt: 1, settings, now: () => new Date(), allowCache: false });
const settingsService = { get: () => settings } as unknown as SettingsService;

const gibberish = () => Array.from({ length: 24 }, () => String.fromCharCode(97 + randomInt(26))).join('');

function record(operation: 'name_check' | 'diagnostic', subject: string, target: string, jobInput: Record<string, unknown> = {}): JobItemRecord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    jobId: '00000000-0000-4000-8000-000000000002',
    jobType: operation === 'name_check' ? 'name_check' : 'diagnostics',
    seq: 1,
    subject,
    unicode: subject,
    suffix: operation === 'diagnostic' ? subject.split('.').slice(1).join('.') : null,
    operation,
    target,
    attempts: 0,
    jobInput,
  };
}

const summary: string[] = [];
function payload(result: OperationResult) {
  const row = result.evidence[0];
  return row?.kind === 'observation' ? row.row.payload : {};
}

describe.skipIf(!live)('live enrichment checks', () => {
  const nameChecks = new NameCheckHandler(defaultFetch);
  const diagnostics = new DiagnosticHandler(defaultFetch, new NodeDnsTransport(), nodeTlsProbe, nodeHttpProbe, settingsService);

  afterAll(() => {
    const text = `Live enrichment results (${new Date().toISOString()}):\n${summary.join('\n')}\n`;
    // The default reporter can hide console output of passing tests, so keep a file copy too.
    writeFileSync(join(tmpdir(), 'domain-scout-enrichment-live.txt'), text);
    console.log(text);
  });

  // `google` is the fixed-set label. GitHub has that organization; for package registries the
  // label may or may not exist, so only a definitive answer is required there.
  const known: [string, string, 'exists' | 'resolved'][] = [
    ['github', 'google', 'exists'],
    ['npm', 'google', 'resolved'],
    ['pypi', 'google', 'resolved'],
    ['crates', 'google', 'resolved'],
  ];
  for (const [service, name, expected] of known) {
    it(`${service}: fixed-set name ${name}`, async () => {
      const result = await nameChecks.execute(record('name_check', name, service), ctx());
      const p = payload(result) as { httpStatus?: number; detail?: unknown };
      summary.push(`name_check ${service} ${name}: ${result.outcome} (HTTP ${p.httpStatus}) ${JSON.stringify(p.detail)}`);
      if (service === 'github' && result.outcome === 'rate_limited') return;
      if (expected === 'exists') expect(result.outcome).toBe('exists');
      else expect(['exists', 'not_found']).toContain(result.outcome);
    });

    it(`${service}: random gibberish name`, async () => {
      const name = gibberish();
      const result = await nameChecks.execute(record('name_check', name, service), ctx());
      const p = payload(result) as { httpStatus?: number };
      summary.push(`name_check ${service} ${name}: ${result.outcome} (HTTP ${p.httpStatus})`);
      if (service === 'github' && result.outcome === 'rate_limited') return;
      expect(result.outcome).toBe('not_found');
    });
  }

  const checks: [string, Record<string, unknown>][] = [
    ['dns', { resolver: 'system' }],
    ['dns', { resolver: 'cloudflare' }],
    ['nameservers', { resolver: 'cloudflare' }],
    ['dnssec', { resolver: 'cloudflare' }],
    ['tls', {}],
    ['http', {}],
  ];
  for (const domain of ['example.com', 'google.com']) {
    for (const [check, input] of checks) {
      it(`${check} ${domain} ${String(input.resolver ?? '')}`.trim(), async () => {
        const result = await diagnostics.execute(record('diagnostic', domain, check, input), ctx());
        const p = payload(result) as { destination?: string; reason?: { code: string }; data?: Record<string, unknown> };
        const d = p.data ?? {};
        const brief =
          check === 'dns' || check === 'nameservers'
            ? JSON.stringify(d.records)
            : check === 'dnssec'
              ? `signed=${String(d.signed)} validated=${String(d.validated)} ad=${JSON.stringify(d.authenticatedData)}`
              : check === 'tls'
                ? `${String(d.protocol)} authorized=${String(d.authorized)} CN=${String(d.subjectCommonName)} issuer=${String(d.issuerCommonName)} validTo=${String(d.validTo)}`
                : `${String(d.method)} ${String(d.status)} location=${String(d.location)} server=${String(d.server)} ${String(d.elapsedMs)}ms`;
        summary.push(`diagnostic ${check} ${domain} via ${p.destination}: ${result.outcome} [${p.reason?.code}] ${brief}`);
        expect(result.outcome).toBe('observed');
        expect(result.evidence.every((e) => e.kind === 'observation' && e.row.kind === 'diagnostic')).toBe(true);
      });
    }
  }
});
