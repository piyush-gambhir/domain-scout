'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { JobItem, Offer, Provider, SuffixPriceOffer } from '@domain-scout/contracts';
import { api } from './api';
import { compareDecimal, horizonEstimate } from './money';
import { useProviders, useSettings } from './queries';

/*
 * Published prices per suffix (GET /prices) drive result prices, the Buy menu and cost columns, so a
 * results page makes one request for every extension instead of one per row. Nothing names a
 * candidate domain: the request carries suffixes only.
 */

export type PricesBySuffix = Map<string, SuffixPriceOffer[]>;

/** Horizon for "N-year estimate" columns: settings, else three years. */
export function useHorizon(): number {
  return useSettings().data?.comparison.horizonYears ?? 3;
}

/** Currency prices are shown in when several exist: the comparison currency, else USD. */
export function usePriceCurrency(): string {
  return useSettings().data?.comparison.currency ?? 'USD';
}

/** The backend answers at most this many suffixes per request. */
const SUFFIX_BATCH = 100;

export function useSuffixPrices(suffixes: string[], horizonYears?: number) {
  const key = useMemo(() => [...new Set(suffixes)].sort(), [suffixes]);
  const query = useQuery({
    queryKey: ['prices', key.join(','), horizonYears ?? null],
    queryFn: async ({ signal }) => {
      const batches: string[][] = [];
      for (let i = 0; i < key.length; i += SUFFIX_BATCH) batches.push(key.slice(i, i + SUFFIX_BATCH));
      const pages = await Promise.all(
        batches.map((batch) => api.call('listSuffixPrices', { query: { suffixes: batch.join(','), ...(horizonYears ? { horizonYears } : {}) }, signal }).then((r) => r.data)),
      );
      return pages.flat();
    },
    enabled: key.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
  const map = useMemo<PricesBySuffix>(() => new Map((query.data ?? []).map((entry) => [entry.suffix, entry.offers])), [query.data]);
  return { ...query, map };
}

/**
 * Lowest known first-year offer for a suffix, in the preferred currency when one is offered there.
 * One-year terms win over longer minimum terms; unknown amounts are never treated as zero.
 */
export function lowestOffer(offers: SuffixPriceOffer[] | undefined, currency: string): SuffixPriceOffer | null {
  const priced = (offers ?? []).filter((o) => o.registration !== null);
  if (priced.length === 0) return null;
  const inCurrency = priced.filter((o) => o.currency === currency);
  const pool = inCurrency.length ? inCurrency : priced.filter((o) => o.currency === priced[0]!.currency);
  // Amounts are compared only within the shortest term offered.
  const term = Math.min(...pool.map((o) => o.registrationYears));
  return pool.filter((o) => o.registrationYears === term).reduce((best, o) => (compareDecimal(o.registration!, best.registration!) < 0 ? o : best));
}

/** One price line for a domain: what a result row or the Buy menu shows. */
export interface PriceLine {
  providerId: string;
  providerName: string;
  currency: string;
  firstYear: string | null;
  firstYearTerm: number;
  renewal: string | null;
  renewalTerm: number;
  horizonTotal: string | null;
  kind: 'published' | 'exact_quote' | 'estimated';
  promotional: boolean;
  observedAt: string;
  freshness: 'fresh' | 'stale' | 'expired';
  /** Shortest registration a quote allows, when longer than the term its amount covers. */
  minYears: number | null;
  /** Promotion conditions as supplied, e.g. a required term; never assumed to apply. */
  promotionNote: string | null;
  url: string | null;
  urlKind: 'search' | 'dashboard' | 'website' | 'checkout' | 'listing' | null;
}

export function buyUrl(template: string | null | undefined, domain: string): string | null {
  if (!template) return null;
  return template.replaceAll('{domain}', encodeURIComponent(domain));
}

export function lineFromSuffixOffer(offer: SuffixPriceOffer, domain: string): PriceLine {
  return {
    providerId: offer.providerId,
    providerName: offer.providerName,
    currency: offer.currency,
    firstYear: offer.registration,
    firstYearTerm: offer.registrationYears,
    renewal: offer.renewal,
    renewalTerm: offer.renewalYears,
    horizonTotal: offer.horizonTotal,
    kind: offer.kind,
    promotional: offer.promotional,
    observedAt: offer.observedAt,
    freshness: offer.freshness,
    minYears: null,
    promotionNote: null,
    url: buyUrl(offer.purchaseUrlTemplate, domain),
    urlKind: offer.purchaseKind,
  };
}

/**
 * An exact quote for one domain, with its estimate computed the same way as GET /prices. A minimum
 * term or a promotion that requires a longer term leaves the estimate unknown rather than guessed.
 */
export function lineFromQuote(offer: Offer, providerName: string, horizon: number, fallbackUrl: string | null): PriceLine {
  const minYears = offer.minYears && offer.minYears > offer.registration.years ? offer.minYears : null;
  const promotion = offer.promotion;
  const requiresLonger = Boolean(promotion?.requiresTermYears && promotion.requiresTermYears > offer.registration.years);
  const promotionNote = promotion
    ? [promotion.description, promotion.requiresTermYears ? `requires ${promotion.requiresTermYears} years` : null, promotion.restrictions, promotion.eligibilityVerified ? null : 'eligibility not verified']
        .filter(Boolean)
        .join(', ')
    : null;
  return {
    providerId: offer.providerId,
    providerName,
    currency: offer.currency,
    firstYear: offer.registration.amount,
    firstYearTerm: offer.registration.years,
    renewal: offer.renewal.amount,
    renewalTerm: offer.renewal.years,
    horizonTotal: minYears || requiresLonger ? null : horizonEstimate(offer.registration.amount, offer.registration.years, offer.renewal.amount, offer.renewal.years, horizon),
    kind: offer.kind,
    promotional: offer.promotion !== null,
    observedAt: offer.observedAt,
    freshness: offer.freshness,
    minYears,
    promotionNote,
    url: offer.destination?.url ?? fallbackUrl,
    urlKind: offer.destination?.kind ?? null,
  };
}

function better(line: PriceLine, current: PriceLine | undefined): boolean {
  if (!current) return true;
  // The shorter term first; amounts are compared only within the same term. Unknown amounts never win.
  if (line.firstYearTerm !== current.firstYearTerm) return line.firstYearTerm < current.firstYearTerm;
  if (line.firstYear === null) return false;
  return current.firstYear === null || compareDecimal(line.firstYear, current.firstYear) < 0;
}

/** A quote whose minimum term exceeds what its amount covers has an unknown commitment. */
function incomparable(line: PriceLine): boolean {
  return line.minYears !== null;
}

function quoteExpired(offer: Offer, now: number): boolean {
  return offer.freshness === 'expired' || (offer.quoteExpiresAt !== null && new Date(offer.quoteExpiresAt).getTime() <= now);
}

/**
 * Price lines for one domain, one per provider and currency: the provider's newest unexpired exact
 * quote when one is retained, else its published suffix price. Amounts in different currencies or
 * terms are never compared. Sorted lowest first payment first inside each currency; unknown last.
 */
export function priceLines(
  domain: string,
  published: SuffixPriceOffer[] | undefined,
  quotes: Offer[],
  horizon: number,
  names: Map<string, string>,
  options: { now?: number; enabled?: Set<string> } = {},
): PriceLine[] {
  const now = options.now ?? Date.now();
  const lines = new Map<string, PriceLine>();
  for (const offer of published ?? []) {
    const line = lineFromSuffixOffer(offer, domain);
    const key = `${offer.providerId}|${offer.currency}`;
    if (better(line, lines.get(key))) lines.set(key, line);
  }
  const newestQuote = new Map<string, Offer>();
  for (const quote of quotes) {
    if (quote.kind !== 'exact_quote' || quote.purchasePath !== 'new_registration' || quote.domain !== domain || quoteExpired(quote, now)) continue;
    // Disabled providers keep their retained evidence but are not offered as a place to buy.
    if (options.enabled && !options.enabled.has(quote.providerId)) continue;
    const key = `${quote.providerId}|${quote.currency}`;
    const current = newestQuote.get(key);
    if (!current || current.observedAt < quote.observedAt) newestQuote.set(key, quote);
  }
  for (const [key, quote] of newestQuote) {
    const fallback = lines.get(key)?.url ?? null;
    lines.set(key, lineFromQuote(quote, names.get(quote.providerId) ?? quote.providerId, horizon, fallback));
  }
  return [...lines.values()].sort((a, b) => {
    if (a.currency !== b.currency) return a.currency.localeCompare(b.currency);
    // Amounts covering different terms are not comparable: lines with an unknown commitment last,
    // then by the term the amount covers, then by amount within that term.
    if (incomparable(a) !== incomparable(b)) return incomparable(a) ? 1 : -1;
    if (a.firstYearTerm !== b.firstYearTerm) return a.firstYearTerm - b.firstYearTerm;
    if (a.firstYear === null) return b.firstYear === null ? a.providerName.localeCompare(b.providerName) : 1;
    if (b.firstYear === null) return -1;
    return compareDecimal(a.firstYear, b.firstYear) || a.providerName.localeCompare(b.providerName);
  });
}

/**
 * The cheapest line to recommend: preferred currency (else the first listed), shortest comparable
 * term. Lines arrive sorted by currency, term and amount, so the first match is the cheapest.
 */
export function cheapestLine(lines: PriceLine[], currency: string): PriceLine | null {
  // Never recommend a price whose required commitment is unknown.
  const priced = lines.filter((l) => l.firstYear !== null && !incomparable(l));
  const pool = priced.some((l) => l.currency === currency) ? priced.filter((l) => l.currency === currency) : priced.filter((l) => l.currency === priced[0]?.currency);
  return pool[0] ?? null;
}

/**
 * The first-year price a result row shows: the row's best price (what results sort by), with renewal
 * and estimate from the same provider's published line; else the suffix's lowest published offer.
 */
export function rowPrice(item: Pick<JobItem, 'subject' | 'suffix' | 'bestPrice'>, prices: PricesBySuffix, currency: string): PriceLine | null {
  const offers = item.suffix ? prices.get(item.suffix) : undefined;
  const best = item.bestPrice;
  if (best) {
    const same = offers?.find((o) => o.providerId === best.providerId && o.currency === best.currency && o.registration === best.amount) ?? offers?.find((o) => o.providerId === best.providerId && o.currency === best.currency);
    if (same) {
      const line = lineFromSuffixOffer(same, item.subject);
      if (same.registration === best.amount && same.registrationYears === best.years) return { ...line, kind: best.kind };
      // Another variant of the provider's price: recompute the estimate from the amounts shown.
      return {
        ...line,
        firstYear: best.amount,
        firstYearTerm: best.years,
        horizonTotal: horizonEstimate(best.amount, best.years, same.renewal, same.renewalYears, same.horizonYears),
        kind: best.kind,
        observedAt: best.observedAt,
        freshness: best.freshness,
      };
    }
    return {
      providerId: best.providerId,
      providerName: best.providerId,
      currency: best.currency,
      firstYear: best.amount,
      firstYearTerm: best.years,
      renewal: null,
      renewalTerm: 1,
      horizonTotal: null,
      kind: best.kind,
      promotional: false,
      observedAt: best.observedAt,
      freshness: best.freshness,
      minYears: null,
      promotionNote: null,
      url: null,
      urlKind: null,
    };
  }
  const lowest = lowestOffer(offers, currency);
  return lowest ? lineFromSuffixOffer(lowest, item.subject) : null;
}

/** Providers for a suffix that publish no price: named registrars with a link, and registry directories. */
export function linkOnlyProviders(providers: Provider[] | undefined, suffix: string, priced: Set<string>) {
  const supports = (p: Provider) => p.enabled && p.purchaseLink !== null && !priced.has(p.id) && (p.suffixes === null ? p.kind === 'registrar' : p.suffixes.includes(suffix));
  const list = (providers ?? []).filter(supports);
  return {
    named: list.filter((p) => p.kind === 'registrar').sort((a, b) => a.name.localeCompare(b.name)),
    directory: list.filter((p) => p.kind === 'directory').sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Enabled provider ids; undefined until providers load, so nothing is hidden early. */
export function useEnabledProviders(): Set<string> | undefined {
  const providers = useProviders();
  return useMemo(() => (providers.data ? new Set(providers.data.filter((p) => p.enabled).map((p) => p.id)) : undefined), [providers.data]);
}

export function useProviderNames(): Map<string, string> {
  const providers = useProviders();
  return useMemo(() => new Map((providers.data ?? []).map((p) => [p.id, p.name])), [providers.data]);
}
