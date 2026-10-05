import type { ComparisonRow, FxRate, Offer, PurchasePath } from '@domain-scout/contracts';
import { compare, dec, format, multiply, sum } from './money.js';

type Missing = ComparisonRow['missing'][number];

export interface RowOptions {
  domain: string;
  providerId: string;
  path: PurchasePath;
  horizonYears: number;
  /** Requested comparison currency; conversion needs an attributed rate. */
  currency: string | null;
  fxRates: FxRate[];
  destination: string | null;
  /** Reference time for promotion expiry; defaults to the offer's observation time. */
  now?: Date;
}

/** Fields that make a total a base subtotal rather than incomplete. */
const SUBTOTAL_FIELDS: Missing[] = ['tax', 'fees'];

/**
 * Ownership cost for one offer. Pure and exact (decimal strings throughout):
 * - initial commitment: the minimum required term at purchase;
 * - horizon total: initial commitment plus the current renewal price for remaining years (an estimate);
 * - prepaid beyond horizon: years the minimum term covers past the horizon, shown separately;
 * - unknown amounts stay null and are listed in `missing`; tax and fees only make it a subtotal.
 */
export function computeRow(offer: Offer | null, promotional: boolean, opts: RowOptions): ComparisonRow {
  if (!offer) return emptyRow(opts);
  const missing = new Set<Missing>();
  const notes: string[] = [];
  const native = offer.currency;

  // Premium amounts are informational: adapters put the applicable price in the registration and
  // renewal lines, and a premium amount without a stated term never becomes part of a total.
  const renewal = offer.renewal.amount;
  const renewalYears = Math.max(1, offer.renewal.years);
  const renewalPerYear = renewal === null ? null : renewalYears === 1 ? renewal : format(dec(renewal).dividedBy(renewalYears));
  if (renewalYears > 1 && renewal !== null) notes.push(`Renewal price covers ${renewalYears} years; the per-year rate is derived from it`);

  let initial: string | null = null;
  let initialYears: number | null = null;
  /** Years of the initial commitment priced at the renewal rate (their amount is attributable). */
  let renewalPricedYears = 0;

  if (opts.path === 'transfer') {
    const amount = offer.transfer.amount;
    if (amount === null) missing.add('transfer');
    initial = amount;
    initialYears = offer.transfer.includesYears;
    if (initialYears === null) {
      missing.add('transfer');
      notes.push('Registration years included with the transfer are not stated, so the horizon total cannot be computed');
    }
  } else if (opts.path === 'renewal') {
    if (renewal === null) missing.add('renewal');
    initial = renewal;
    initialYears = renewalYears;
  } else {
    const registration = offer.registration.amount;
    const registrationYears = Math.max(1, offer.registration.years);
    if (registration === null) missing.add('registration');
    if (opts.path === 'new_registration' && (offer.premium.status === 'unknown' || offer.premium.status === 'hint')) {
      missing.add('premium');
      notes.push(
        offer.kind === 'published'
          ? 'Published prices assume a standard name; premium status is unknown until a provider quote confirms it'
          : 'The provider did not state whether this name is premium',
      );
    }
    const minYears = Math.max(offer.minYears ?? registrationYears, registrationYears);
    initialYears = minYears;
    if (registration !== null) {
      if (minYears === registrationYears) {
        initial = registration;
      } else if (renewalPerYear !== null) {
        renewalPricedYears = minYears - registrationYears;
        initial = sum(registration, multiply(renewalPerYear, renewalPricedYears));
        notes.push(`A minimum term of ${minYears} years is required; years after the first are priced at the current renewal rate (estimate)`);
      } else {
        missing.add('renewal');
      }
    }
    if (promotional) {
      // The price already includes the promotion, so its conditions decide whether the total holds.
      notes.push('The first-year price is promotional; later years use the renewal price');
      const promo = offer.promotion;
      const now = (opts.now ?? new Date(offer.observedAt)).getTime();
      if (!promo || !promo.eligibilityVerified) missing.add('promotion_eligibility');
      if (promo?.requiresTermYears && promo.requiresTermYears > minYears) {
        missing.add('promotion_eligibility');
        notes.push(`The promotional price requires a ${promo.requiresTermYears}-year term`);
      }
      if (promo?.expiresAt && Date.parse(promo.expiresAt) <= now) {
        missing.add('promotion_eligibility');
        notes.push('The promotion has expired');
      }
    } else if (offer.promotion) {
      notes.push(`Promotion not applied: ${offer.promotion.description}`);
    }
  }

  // Fees: ICANN fee per registration year, other fees once at purchase. Unknown fees make a subtotal.
  const feesKnown = offer.fees.icann !== null && offer.fees.other.every((f) => f.amount !== null);
  if (!feesKnown) missing.add('fees');
  const oneTimeFees = sum(...offer.fees.other.map((f) => f.amount).filter((a): a is string => a !== null));
  const icannFor = (years: number) => (offer.fees.icann === null ? '0' : multiply(offer.fees.icann, years));
  if (offer.fees.tax !== 'included') missing.add('tax');
  if (offer.fees.tax === 'excluded') notes.push('Tax is charged on top; its amount is unknown');

  let horizonTotal: string | null = null;
  let prepaid: ComparisonRow['prepaidBeyondHorizon'] = null;
  const horizon = opts.horizonYears;
  if (initial !== null && initialYears !== null) {
    const initialWithFees = sum(initial, oneTimeFees, icannFor(initialYears));
    if (initialYears >= horizon) {
      horizonTotal = initialWithFees;
      if (initialYears > horizon) {
        const beyond = initialYears - horizon;
        // Only renewal-priced years of the term have an attributable amount.
        const amount = beyond <= renewalPricedYears && renewalPerYear !== null ? sum(multiply(renewalPerYear, beyond), icannFor(beyond)) : null;
        prepaid = { years: beyond, amount };
        notes.push(`The required term covers ${beyond} year(s) beyond the ${horizon}-year horizon; that prepaid cost is included in the total`);
      }
    } else if (renewalPerYear !== null) {
      const remaining = horizon - initialYears;
      horizonTotal = sum(initialWithFees, multiply(renewalPerYear, remaining), icannFor(remaining));
      notes.push('Future renewals are estimated from the current renewal price');
    } else {
      missing.add('renewal');
    }
  }
  const initialCommitment = initial === null || initialYears === null ? initial : sum(initial, oneTimeFees, icannFor(initialYears));

  // Optional conversion with an attributed rate; native amounts are kept when none is configured.
  let currency = native;
  let fx: ComparisonRow['fx'] = null;
  let converted = { initialCommitment, horizonTotal, prepaidAmount: prepaid?.amount ?? null };
  if (opts.currency && opts.currency !== native) {
    const rate = opts.fxRates.find((r) => r.from === native && r.to === opts.currency);
    if (rate) {
      currency = opts.currency;
      fx = { rate: rate.rate, source: rate.source, observedAt: rate.observedAt };
      converted = {
        initialCommitment: multiply(initialCommitment, rate.rate),
        horizonTotal: multiply(horizonTotal, rate.rate),
        prepaidAmount: multiply(prepaid?.amount ?? null, rate.rate),
      };
      notes.push(`Converted from ${native} at ${rate.rate} (${rate.source}, ${rate.observedAt})`);
    } else {
      missing.add('fx_rate');
      notes.push(`No attributed ${native} to ${opts.currency} rate is configured; amounts stay in ${native}`);
    }
  }

  if (offer.freshness !== 'fresh') notes.push(offer.freshness === 'expired' ? 'The quote has expired; request a new quote' : 'The price is stale; refresh before purchase');
  const blocking = [...missing].filter((m) => !SUBTOTAL_FIELDS.includes(m));
  return {
    domain: opts.domain,
    providerId: opts.providerId,
    offerId: offer.id,
    kind: offer.kind,
    currency,
    nativeCurrency: native,
    fx,
    initialCommitment: converted.initialCommitment,
    initialYears,
    horizonTotal: converted.horizonTotal,
    prepaidBeyondHorizon: prepaid ? { years: prepaid.years, amount: converted.prepaidAmount } : null,
    subtotalOnly: missing.has('tax') || missing.has('fees'),
    complete: blocking.length === 0 && converted.horizonTotal !== null,
    missing: [...missing],
    rank: null,
    freshness: offer.freshness,
    observedAt: offer.observedAt,
    destination: opts.destination,
    notes,
  };
}

function emptyRow(opts: RowOptions): ComparisonRow {
  const missing: Missing[] =
    opts.path === 'transfer' ? ['transfer', 'renewal'] : opts.path === 'renewal' ? ['renewal'] : ['registration', 'renewal'];
  return {
    domain: opts.domain,
    providerId: opts.providerId,
    offerId: null,
    kind: null,
    currency: null,
    nativeCurrency: null,
    fx: null,
    initialCommitment: null,
    initialYears: null,
    horizonTotal: null,
    prepaidBeyondHorizon: null,
    subtotalOnly: true,
    complete: false,
    missing,
    rank: null,
    freshness: null,
    observedAt: null,
    destination: opts.destination,
    notes: ['No price is known from this provider for this purchase path'],
  };
}

/** Basis that makes totals comparable: same currency and the same fee and tax treatment. */
function basis(row: ComparisonRow): string {
  return `${row.currency}|fees:${row.missing.includes('fees') ? 'unknown' : 'known'}|tax:${row.missing.includes('tax') ? 'unknown' : 'known'}`;
}

type Lowest = { domain: string; currency: string; providerId: string; horizonTotal: string };

/**
 * Ranks complete, unexpired rows per domain within one comparable basis (competition ranking:
 * ties share a rank). Rows whose fees or tax are unknown rank only against rows with the same
 * basis, as base subtotals. `cheapest` holds confirmed totals only (known fees and tax);
 * `lowestSubtotal` holds the lowest base subtotal per domain and currency when a single subtotal
 * basis exists. Neither is claimed across different bases.
 */
export function rankRows(rows: ComparisonRow[]): { rows: ComparisonRow[]; cheapest: Lowest[]; lowestSubtotal: Lowest[]; limits: string[] } {
  const groups = new Map<string, ComparisonRow[]>();
  for (const row of rows) {
    if (!row.complete || row.horizonTotal === null || row.currency === null || row.freshness === 'expired') continue;
    const key = `${row.domain}\u0000${basis(row)}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => compare(a.horizonTotal!, b.horizonTotal!));
    let rank = 0;
    list.forEach((row, i) => {
      if (i === 0 || compare(row.horizonTotal!, list[i - 1]!.horizonTotal!) !== 0) rank = i + 1;
      row.rank = rank;
    });
  }
  const cheapest: Lowest[] = [];
  const lowestSubtotal: Lowest[] = [];
  const limits: string[] = [];
  // Per domain and currency: the confirmed-total group (at most one basis) and the subtotal groups.
  const byDomainCurrency = new Map<string, { confirmed: ComparisonRow[] | null; subtotals: ComparisonRow[][] }>();
  for (const [key, list] of groups) {
    const domain = key.split('\u0000')[0]!;
    const k = `${domain}\u0000${list[0]!.currency}`;
    const entry = byDomainCurrency.get(k) ?? { confirmed: null, subtotals: [] };
    if (list[0]!.subtotalOnly) entry.subtotals.push(list);
    else entry.confirmed = list;
    byDomainCurrency.set(k, entry);
  }
  const lowest = (list: ComparisonRow[], domain: string, currency: string) =>
    list.filter((r) => r.rank === 1).map((row) => ({ domain, currency, providerId: row.providerId, horizonTotal: row.horizonTotal! }));
  for (const [k, entry] of byDomainCurrency) {
    const [domain, currency] = k.split('\u0000') as [string, string];
    if (entry.confirmed) cheapest.push(...lowest(entry.confirmed, domain, currency));
    if (entry.subtotals.length > 1) {
      limits.push(`${domain} (${currency}): subtotal rows leave out different fees or tax, so no single lowest subtotal is claimed`);
    } else if (entry.subtotals.length === 1) {
      lowestSubtotal.push(...lowest(entry.subtotals[0]!, domain, currency));
    }
  }
  return { rows, cheapest, lowestSubtotal, limits };
}
