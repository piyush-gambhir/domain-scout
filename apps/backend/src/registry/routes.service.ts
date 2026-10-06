import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { Database, json } from '../storage/database.js';
import { BootstrapJson, BootstrapSnapshot, loadRegistryData, type CuratedRdapSpec, type WhoisRouteSpec } from './data.js';
import { RegistryHttpTransport } from './rdap/http-transport.js';

export const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_METADATA_KEY = 'registry.rdap_bootstrap';
const BOOTSTRAP_MAX_BYTES = 5 * 1024 * 1024;
const BOOTSTRAP_TIMEOUT_MS = 30_000;

/**
 * Where a suffix's registration data is queried. Second-level suffixes route through their TLD unless
 * a curated route names their own registry (co.za).
 */
export interface RegistryRoute {
  /** Routed suffix: a TLD, or a second-level suffix with its own registry. */
  tld: string;
  /** Shared budget and cooldown key; RDAP and WHOIS hosts of one operator share it. */
  registryId: string;
  protocol: 'rdap' | 'whois';
  /** RDAP base URL ending in `/`, or WHOIS `host:port`. */
  endpoint: string;
  host: string;
  routing: 'iana_bootstrap' | 'curated';
  routingUpdatedAt: string;
  /** Registry-published RDAP service used because the TLD is missing from the IANA bootstrap. */
  curatedRdap: CuratedRdapSpec | null;
  whois: WhoisRouteSpec | null;
}

export interface BootstrapInfo {
  source: string;
  publishedAt: string | null;
  fetchedAt: string;
  /** `bundled` ships with the app; `refreshed` was fetched by POST /coverage/refresh. */
  origin: 'bundled' | 'refreshed';
}

/**
 * Registry routing, in order of preference: the IANA RDAP bootstrap, registry-published RDAP
 * services missing from the bootstrap (curated-rdap.json), then curated WHOIS routes with a
 * registry-specific classifier. DNS is never a fallback: a TLD without a route is unsupported.
 */
@Injectable()
export class RoutesService {
  private readonly logger = new Logger('RegistryRoutes');
  private routes = new Map<string, RegistryRoute>();
  /** TLDs whose bootstrap entry lists only plain-HTTP endpoints, with those URLs. */
  private httpOnly = new Map<string, string[]>();
  private rdapHostSet = new Set<string>();
  private info!: BootstrapInfo;
  private readonly operatorByHost = new Map<string, string>();
  /**
   * Reviewed second-level zones each TLD's registry does not (verifiably) serve, from the curated
   * data. They apply whichever endpoint wins, so an IANA bootstrap refresh cannot reopen them.
   */
  private readonly unservedZones = new Map<string, string[]>();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly http: RegistryHttpTransport,
  ) {
    const data = loadRegistryData();
    for (const operator of data.operators.registries) {
      for (const host of [...operator.rdapHosts, ...operator.whoisHosts]) this.operatorByHost.set(host, operator.id);
    }
    // Curated routes name their operator explicitly, so a 404 from their host counts as authoritative.
    for (const spec of data.curatedRdap.routes) this.operatorByHost.set(new URL(spec.baseUrl).host, spec.registryId);
    for (const spec of data.whois.routes) this.operatorByHost.set(spec.host, spec.registryId);
    for (const spec of [...data.curatedRdap.routes, ...data.whois.routes]) {
      if (spec.unservedSecondLevel) this.unservedZones.set(spec.tld, [...(this.unservedZones.get(spec.tld) ?? []), ...spec.unservedSecondLevel]);
    }
    const bundled = this.compute(loadRegistryData().bootstrap, 'bundled');
    const selected = this.selectSnapshot();
    let state = bundled;
    if (selected.origin === 'refreshed') {
      try {
        const stored = this.compute(selected.snapshot, 'refreshed');
        // Same usability guard as refresh(): never start with far fewer RDAP routes than the bundled data.
        if (this.routeCount(stored.routes, 'rdap') >= this.routeCount(bundled.routes, 'rdap') / 2) state = stored;
        else this.logger.warn('Ignoring a stored RDAP bootstrap with too few usable endpoints');
      } catch (error) {
        this.logger.warn(`Ignoring a stored RDAP bootstrap that cannot be used: ${(error as Error).message}`);
      }
    }
    this.apply(state);
  }

  /**
   * Route for a registration suffix (`com`, `co.uk`), or null when unsupported. A second-level suffix
   * with its own registry route (`co.za`) uses it; others route through their TLD.
   */
  route(suffix: string): RegistryRoute | null {
    const stub = this.testRoutes.get(suffix);
    if (stub) return stub;
    const own = this.routes.get(suffix);
    if (own) return own;
    return this.unserved(suffix) ? null : (this.routes.get(suffix.slice(suffix.lastIndexOf('.') + 1)) ?? null);
  }

  /** Second-level zones under a TLD that are never routed through it ('*' means all). */
  unservedSecondLevel(tld: string): string[] {
    return this.unservedZones.get(tld) ?? [];
  }

  /** Why a suffix has no route, for messages: names the TLD route that excludes a second-level zone. */
  unsupportedReason(suffix: string): string {
    const tld = suffix.slice(suffix.lastIndexOf('.') + 1);
    const route = this.routes.get(tld);
    if (route && !this.routes.has(suffix) && this.unserved(suffix)) {
      return `the .${tld} registry route (${route.endpoint}) does not cover the .${suffix} zone: it is run elsewhere or the registry does not document serving it`;
    }
    return 'no RDAP service in the IANA bootstrap or the curated registry list, and no registry-specific WHOIS classifier';
  }

  private unserved(suffix: string): boolean {
    const tld = suffix.slice(suffix.lastIndexOf('.') + 1);
    if (suffix === tld) return false;
    const zones = this.unservedSecondLevel(tld);
    return zones.includes('*') || zones.includes(suffix);
  }

  all(): RegistryRoute[] {
    return [...this.routes.values()];
  }

  httpOnlyEndpoints(tld: string): string[] | null {
    return this.httpOnly.get(tld) ?? null;
  }

  /** RDAP hosts named by the bootstrap or the curated operator list; the only redirect targets we follow. */
  isVerifiedRdapHost(host: string): boolean {
    return this.rdapHostSet.has(host.toLowerCase());
  }

  bootstrapInfo(): BootstrapInfo {
    return this.info;
  }

  /**
   * Test-only RDAP routes from DOMAIN_SCOUT_TEST_RDAP_ROUTES ({"com": "http://127.0.0.1:9999/"}), used
   * by the local acceptance run against a stub registry. Only loopback URLs are accepted, so the
   * override can never send candidate names anywhere but this machine.
   */
  private readonly testRoutes: Map<string, RegistryRoute> = testRdapRoutes(process.env.DOMAIN_SCOUT_TEST_RDAP_ROUTES);

  registryIdForHost(host: string): string {
    return this.operatorByHost.get(host) ?? host;
  }

  /** Fetches the live IANA bootstrap (no candidate names), stores it and rebuilds routes. */
  async refresh(): Promise<BootstrapInfo> {
    const signal = AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS);
    let snapshot: BootstrapSnapshot;
    try {
      const response = await this.http.get({
        url: IANA_BOOTSTRAP_URL,
        headers: { accept: 'application/json' },
        signal,
        maxBytes: BOOTSTRAP_MAX_BYTES,
      });
      if (response.status !== 200) throw new Error(`IANA answered HTTP ${response.status}`);
      if (response.truncated) throw new Error('Bootstrap exceeded the size limit');
      const bootstrap = BootstrapJson.parse(JSON.parse(response.body));
      snapshot = {
        source: IANA_BOOTSTRAP_URL,
        fetchedAt: this.clock.iso(),
        lastModified: toIsoOrNull(response.headers['last-modified']),
        bootstrap,
      };
    } catch (error) {
      throw new AppError('unavailable', `IANA bootstrap refresh failed: ${(error as Error).message}`, {
        source: 'iana',
        retryable: true,
      });
    }

    const unavailable = (message: string) => new AppError('unavailable', message, { source: 'iana', retryable: true });
    const currentPublished = this.info.publishedAt ? Date.parse(this.info.publishedAt) : 0;
    const nextPublished = Date.parse(snapshot.bootstrap.publication);
    if (Number.isNaN(nextPublished)) throw unavailable('Fetched bootstrap has no valid publication date; keeping the current routes');
    if (nextPublished < currentPublished) {
      throw unavailable(`Fetched bootstrap (published ${snapshot.bootstrap.publication}) is older than the current one; keeping the current routes`);
    }
    // Build everything before persisting, so a bad file can never replace working routes.
    const state = this.compute(snapshot, 'refreshed');
    const current = this.routeCount(this.routes, 'rdap');
    const next = this.routeCount(state.routes, 'rdap');
    if (next < current / 2) {
      throw unavailable(`Fetched bootstrap yields ${next} RDAP routes, fewer than half of the current ${current}; keeping the current routes`);
    }
    this.db.run(
      `INSERT INTO metadata (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [BOOTSTRAP_METADATA_KEY, json.stringify(snapshot), this.clock.iso()],
    );
    this.apply(state);
    return this.info;
  }

  private routeCount(routes: Map<string, RegistryRoute>, protocol: RegistryRoute['protocol']) {
    let count = 0;
    for (const route of routes.values()) if (route.protocol === protocol) count++;
    return count;
  }

  /** The bundled snapshot, unless a refreshed one with a publication date at least as new is stored. */
  private selectSnapshot(): { snapshot: BootstrapSnapshot; origin: BootstrapInfo['origin'] } {
    const bundled = loadRegistryData().bootstrap;
    const row = this.db.get<{ value_json: string }>('SELECT value_json FROM metadata WHERE key = ?', [BOOTSTRAP_METADATA_KEY]);
    if (row) {
      const stored = BootstrapSnapshot.safeParse(json.parse(row.value_json, null));
      if (stored.success && Date.parse(stored.data.bootstrap.publication) >= Date.parse(bundled.bootstrap.publication)) {
        return { snapshot: stored.data, origin: 'refreshed' };
      }
      if (!stored.success) this.logger.warn('Ignoring an unreadable stored RDAP bootstrap');
    }
    return { snapshot: bundled, origin: 'bundled' };
  }

  private apply(state: RouteState) {
    this.routes = state.routes;
    this.httpOnly = state.httpOnly;
    this.rdapHostSet = state.rdapHosts;
    this.info = state.info;
  }

  /** Pure: derives routes from a snapshot. Endpoints that are not valid https URLs are skipped. */
  private compute(snapshot: BootstrapSnapshot, origin: BootstrapInfo['origin']): RouteState {
    const routes = new Map<string, RegistryRoute>();
    const httpOnly = new Map<string, string[]>();
    const rdapHosts = new Set<string>();
    const publishedAt = toIsoOrNull(snapshot.bootstrap.publication);
    const routingUpdatedAt = publishedAt ?? snapshot.fetchedAt;

    for (const [tlds, urls] of snapshot.bootstrap.services) {
      const https = urls.map(httpsBase).find((base) => base !== null) ?? null;
      for (const rawTld of tlds) {
        const tld = rawTld.toLowerCase();
        if (!https) {
          httpOnly.set(tld, urls);
          continue;
        }
        const { base, host } = https;
        rdapHosts.add(host);
        routes.set(tld, {
          tld,
          registryId: this.registryIdForHost(host),
          protocol: 'rdap',
          endpoint: base,
          host,
          routing: 'iana_bootstrap',
          routingUpdatedAt,
          curatedRdap: null,
          whois: null,
        });
      }
    }

    const data = loadRegistryData();
    for (const operator of data.operators.registries) for (const host of operator.rdapHosts) rdapHosts.add(host);
    for (const spec of data.curatedRdap.routes) {
      const host = new URL(spec.baseUrl).host;
      rdapHosts.add(host);
      if (routes.has(spec.tld)) continue;
      routes.set(spec.tld, {
        tld: spec.tld,
        registryId: spec.registryId,
        protocol: 'rdap',
        endpoint: spec.baseUrl,
        host,
        routing: 'curated',
        routingUpdatedAt: toIsoOrNull(spec.verifiedAt) ?? data.curatedRdap.updatedAt,
        curatedRdap: spec,
        whois: null,
      });
    }
    for (const spec of data.whois.routes) {
      if (routes.has(spec.tld)) continue;
      routes.set(spec.tld, {
        tld: spec.tld,
        registryId: spec.registryId,
        protocol: 'whois',
        endpoint: `${spec.host}:${spec.port}`,
        host: spec.host,
        routing: 'curated',
        routingUpdatedAt: toIsoOrNull(spec.verifiedAt) ?? data.whois.updatedAt,
        curatedRdap: null,
        whois: spec,
      });
    }

    return { routes, httpOnly, rdapHosts, info: { source: snapshot.source, publishedAt, fetchedAt: snapshot.fetchedAt, origin } };
  }
}

interface RouteState {
  routes: Map<string, RegistryRoute>;
  httpOnly: Map<string, string[]>;
  rdapHosts: Set<string>;
  info: BootstrapInfo;
}

/** Base URL (ending in `/`) and host for a usable https bootstrap URL, else null. */
function httpsBase(url: string): { base: string; host: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.host === '' || parsed.search !== '' || parsed.hash !== '') return null;
    const base = parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`;
    return { base, host: parsed.host.toLowerCase() };
  } catch {
    return null;
  }
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

const testRoutesLogger = new Logger('Registry');

export function testRdapRoutes(raw: string | undefined): Map<string, RegistryRoute> {
  const routes = new Map<string, RegistryRoute>();
  if (!raw) return routes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('DOMAIN_SCOUT_TEST_RDAP_ROUTES must be a JSON object of suffix to loopback RDAP base URL');
  }
  for (const [suffix, base] of Object.entries(parsed as Record<string, unknown>)) {
    const url = new URL(String(base));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`DOMAIN_SCOUT_TEST_RDAP_ROUTES: ${suffix} must point at a loopback http(s) URL`);
    }
    const endpoint = url.href.endsWith('/') ? url.href : `${url.href}/`;
    routes.set(suffix.toLowerCase(), {
      tld: suffix.toLowerCase(),
      registryId: url.host,
      protocol: 'rdap',
      endpoint,
      host: url.host,
      routing: 'curated',
      routingUpdatedAt: new Date(0).toISOString(),
      curatedRdap: null,
      whois: null,
    });
  }
  if (routes.size) testRoutesLogger.warn(`Test RDAP routes active for: ${[...routes.keys()].join(', ')} (loopback only)`);
  return routes;
}
