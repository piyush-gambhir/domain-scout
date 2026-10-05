import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/core/clock.js';
import { Database } from '../../src/storage/database.js';
import { REGISTRY_DATA_DIR, loadRegistryData, type LiveValidation, type LiveValidationResult } from '../../src/registry/data.js';
import { InputPreviewService } from '../../src/registry/input/input-preview.service.js';
import { FetchHttpTransport } from '../../src/registry/rdap/http-transport.js';
import { RegistryChecker } from '../../src/registry/registry-checker.js';
import { RoutesService } from '../../src/registry/routes.service.js';
import { NetWhoisTransport } from '../../src/registry/whois/whois-transport.js';

/**
 * Authorized live validation. Sends ONLY the fixed test set (example.com, google.com, nic.si,
 * bbc.co.uk and random 24-character lowercase labels) and ONLY to the routed registry RDAP/WHOIS
 * servers, at least 1.1 s apart per registry. Runs with DOMAIN_SCOUT_LIVE_TESTS=1; with
 * DOMAIN_SCOUT_LIVE_RECORD=1 it also rewrites data/registry/live-validation.json.
 */
const LIVE = process.env.DOMAIN_SCOUT_LIVE_TESTS === '1';
const RECORD = process.env.DOMAIN_SCOUT_LIVE_RECORD === '1';
const PACE_MS = 1100;

const gibberish = () => Array.from(randomBytes(24), (b) => String.fromCharCode(97 + (b % 26))).join('');

const CASES: { domain: string; expected: 'registered' | 'no_record' }[] = [
  { domain: 'example.com', expected: 'registered' },
  { domain: 'google.com', expected: 'registered' },
  { domain: `${gibberish()}.com`, expected: 'no_record' },
  { domain: 'nic.si', expected: 'registered' },
  { domain: `${gibberish()}.si`, expected: 'no_record' },
  { domain: 'bbc.co.uk', expected: 'registered' },
  { domain: `${gibberish()}.co.uk`, expected: 'no_record' },
  { domain: `${gibberish()}.uk`, expected: 'no_record' },
  { domain: `${gibberish()}.dev`, expected: 'no_record' },
  { domain: `${gibberish()}.de`, expected: 'no_record' },
  { domain: `${gibberish()}.io`, expected: 'no_record' },
];

const TRANSPORT_FAILURES = new Set(['timeout', 'network_error']);

describe.skipIf(!LIVE)('registry live validation (fixed test set)', () => {
  const db = new Database(':memory:');
  db.migrate();
  const clock = new SystemClock();
  const routes = new RoutesService(db, clock, new FetchHttpTransport());
  const checker = new RegistryChecker(new FetchHttpTransport(), new NetWhoisTransport(), routes);
  const inputs = new InputPreviewService(db);
  const results: LiveValidationResult[] = [];
  const notRun: LiveValidation['notRun'] = [];

  afterAll(() => {
    db.close();
    if (!RECORD) return;
    const previous = loadRegistryData().liveValidation;
    const attempted = new Set(CASES.map((c) => inputs.normalize(c.domain)!.suffix));
    const record: LiveValidation = {
      description: previous.description,
      results,
      notRun: [...previous.notRun.filter((entry) => !attempted.has(entry.suffix)), ...notRun],
    };
    writeFileSync(`${REGISTRY_DATA_DIR}live-validation.json`, `${JSON.stringify(record, null, 2)}\n`);
  });

  it('classifies every name as expected wherever the registry answered', async () => {
    const byRegistry = new Map<string, typeof CASES>();
    for (const testCase of CASES) {
      const domain = inputs.normalize(testCase.domain)!;
      const route = routes.route(domain.suffix)!;
      byRegistry.set(route.registryId, [...(byRegistry.get(route.registryId) ?? []), testCase]);
    }

    await Promise.all(
      [...byRegistry.values()].map(async (cases) => {
        for (const [index, testCase] of cases.entries()) {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, PACE_MS));
          const domain = inputs.normalize(testCase.domain)!;
          const route = routes.route(domain.suffix)!;
          const result = await checker.check(domain, route, { signal: new AbortController().signal, timeoutMs: 15_000, now: () => clock.now() });
          const c = result.classification;
          const at = clock.iso();
          if (TRANSPORT_FAILURES.has(c.reason.code)) {
            notRun.push({ suffix: domain.suffix, destination: route.endpoint, reason: `${c.reason.code}: ${c.reason.message}`, at });
            continue;
          }
          results.push({
            domain: domain.ascii,
            suffix: domain.suffix,
            protocol: route.protocol,
            destination: route.endpoint,
            expected: testCase.expected,
            observed: c.outcome,
            at,
            httpStatus: c.httpStatus,
            reason: c.reason.code,
          });
        }
      }),
    );

    results.sort((a, b) => a.suffix.localeCompare(b.suffix) || a.domain.localeCompare(b.domain));
    console.table(results.map((r) => ({ domain: r.domain, destination: r.destination, expected: r.expected, observed: r.observed, http: r.httpStatus })));
    if (notRun.length > 0) console.table(notRun);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.observed, `${r.domain} via ${r.destination} (${r.reason})`).toBe(r.expected);
  }, 120_000);
});
