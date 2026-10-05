import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * servers, at least 2 s apart per registry. Runs with DOMAIN_SCOUT_LIVE_TESTS=1.
 *
 * DOMAIN_SCOUT_LIVE_SUFFIXES=be,dk limits the run to those suffixes. DOMAIN_SCOUT_LIVE_RECORD=1
 * updates data/registry/live-validation.json, replacing results only for the suffixes attempted.
 * DOMAIN_SCOUT_LIVE_CAPTURE_DIR=<dir> writes each response (status, content type, sanitized body)
 * there, as raw material for captured_live fixtures.
 */
const LIVE = process.env.DOMAIN_SCOUT_LIVE_TESTS === '1';
const RECORD = process.env.DOMAIN_SCOUT_LIVE_RECORD === '1';
const ONLY = process.env.DOMAIN_SCOUT_LIVE_SUFFIXES?.split(',').map((suffix) => suffix.trim().toLowerCase()).filter(Boolean) ?? null;
const CAPTURE_DIR = process.env.DOMAIN_SCOUT_LIVE_CAPTURE_DIR ?? null;
const PACE_MS = 2000;

const gibberish = () => Array.from(randomBytes(24), (b) => String.fromCharCode(97 + (b % 26))).join('');

const FIXED_CASES: { domain: string; expected: 'registered' | 'no_record' }[] = [
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
const fixedSuffixes = new Set(FIXED_CASES.map((c) => c.domain.slice(c.domain.indexOf('.') + 1)));

/** Plus one random label per curated RDAP service and per curated WHOIS or DAS route (including co.za and the like). */
const ALL_CASES = [
  ...FIXED_CASES,
  ...[...loadRegistryData().curatedRdap.routes, ...loadRegistryData().whois.routes]
    .filter((route) => !fixedSuffixes.has(route.tld))
    .map((route) => ({ domain: `${gibberish()}.${route.tld}`, expected: 'no_record' as const })),
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
  const suffixOf = (name: string) => inputs.normalize(name)!.suffix;
  const CASES = ONLY ? ALL_CASES.filter((c) => ONLY.includes(suffixOf(c.domain))) : ALL_CASES;
  if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });

  afterAll(() => {
    db.close();
    if (!RECORD) return;
    const previous = loadRegistryData().liveValidation;
    const attempted = new Set(CASES.map((c) => suffixOf(c.domain)));
    const record: LiveValidation = {
      description: previous.description,
      results: [...previous.results.filter((r) => !attempted.has(r.suffix)), ...results].sort(
        (a, b) => a.suffix.localeCompare(b.suffix) || a.domain.localeCompare(b.domain),
      ),
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
          if (CAPTURE_DIR && result.raw) {
            const capture = { at, domain: domain.ascii, destination: route.endpoint, status: c.httpStatus, ...result.raw, outcome: c.outcome, reason: c.reason.code };
            writeFileSync(join(CAPTURE_DIR, `${domain.ascii}.json`), `${JSON.stringify(capture, null, 2)}\n`);
          }
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
  }, 180_000);
});
