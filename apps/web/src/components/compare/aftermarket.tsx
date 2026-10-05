'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { OperationResponse } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { LISTING_STATUS, humanize } from '@/lib/labels';
import { formatMoney, plural } from '@/lib/format';
import { qk } from '@/lib/queries';
import { useIdempotency } from '@/lib/use-idempotency';
import { isTerminal, useLiveJob } from '@/lib/use-job';
import { Disclosure, joinNames } from '../actions/disclosure';
import { useJobStarted } from '../actions/use-job-started';
import { CheckedAt } from '../domain/time';
import { ErrorState, SectionTitle } from '../states';
import { StatusLabel } from '../status';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { SkeletonRows } from '../ui/skeleton';
import { DomainsField, OutLink, usableDomains } from './shared';

type Source = OperationResponse<'listAftermarketSources'>['data'][number];

function searchUrl(source: Source, domain: string): string | null {
  return source.searchUrlTemplate ? source.searchUrlTemplate.replaceAll('{domain}', encodeURIComponent(domain)) : null;
}

function DomainListings({ domain, linkOnly }: { domain: string; linkOnly: Source[] }) {
  const listings = useQuery({
    queryKey: qk.listings(domain),
    queryFn: ({ signal }) => api.call('listDomainListings', { params: { name: domain }, query: { limit: 100 }, signal }).then((r) => r.data),
  });
  const links = linkOnly.map((s) => ({ source: s, url: searchUrl(s, domain) })).filter((l): l is { source: Source; url: string } => Boolean(l.url));
  return (
    <section aria-label={`Listings for ${domain}`} data-testid="domain-listings">
      <h4 className="mb-2 font-mono text-sm font-semibold">
        <Link href={`/domains/${encodeURIComponent(domain)}`} className="underline-offset-4 hover:underline">
          {domain}
        </Link>
      </h4>
      {listings.isPending ? (
        <SkeletonRows rows={2} />
      ) : listings.isError ? (
        <ErrorState error={listings.error} onRetry={() => listings.refetch()} />
      ) : listings.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No retained listing evidence.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {listings.data.map((listing) => (
            <li key={listing.id} className="text-sm" data-testid="listing">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="font-medium">{listing.marketplace}</span>
                <StatusLabel status={LISTING_STATUS[listing.status] ?? { label: humanize(listing.status), tone: 'muted' }} />
                {listing.price ? (
                  <span className="font-mono tabular">
                    {formatMoney(listing.price.amount, listing.price.currency)} <span className="font-sans text-muted-foreground">asking</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Price unknown</span>
                )}
                <span className="text-muted-foreground">
                  <CheckedAt iso={listing.observedAt} freshness={listing.freshness} />
                </span>
                <span className="text-xs text-muted-foreground">{listing.source}</span>
                {listing.url ? <OutLink href={listing.url} label="Listing" provider={listing.marketplace} /> : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{listing.caveat}</p>
            </li>
          ))}
        </ul>
      )}
      {links.length > 0 ? (
        <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span className="text-muted-foreground">Search</span>
          {links.map(({ source, url }) => (
            <OutLink key={source.id} href={url} label={source.name} provider={source.name} />
          ))}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Aftermarket listing evidence. Listings are not proof of seller authority or final cost. A lookup
 * sends names only to the marketplaces chosen here, after the disclosure line names them.
 */
export function Aftermarket({ domainsText, onDomainsText, autoRun }: { domainsText: string; onDomainsText: (v: string) => void; autoRun: boolean }) {
  const client = useQueryClient();
  const started = useJobStarted();
  const idempotency = useIdempotency();
  const [submitted, setSubmitted] = useState<string[] | null>(() => (autoRun ? usableDomains(domainsText) : null));
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const sources = useQuery({
    queryKey: qk.aftermarketSources,
    queryFn: ({ signal }) => api.call('listAftermarketSources', { signal }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const supported = (sources.data ?? []).filter((s) => s.supported);
  const linkOnly = (sources.data ?? []).filter((s) => !s.supported);
  const selected = supported.filter((s) => chosen.has(s.id));
  const domains = usableDomains(domainsText);

  const job = useLiveJob(jobId);
  const done = isTerminal(job.data);
  useEffect(() => {
    if (jobId && done) void client.invalidateQueries({ queryKey: ['listings'] });
  }, [client, jobId, done]);

  const lookup = useMutation({
    mutationFn: async () => {
      if (!domains) throw new Error('Add valid domains first.');
      const body = { domains, sources: selected.map((s) => s.id) };
      return (await api.call('createAftermarket', { body, idempotencyKey: idempotency.keyFor(body) })).data;
    },
    onSuccess: (created) => {
      idempotency.reset();
      setJobId(created.id);
      setSubmitted(domains);
      started(created, 'Listing lookup started');
    },
  });

  return (
    <div className="flex flex-col gap-10">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (domains) setSubmitted(domains);
        }}
      >
        <DomainsField value={domainsText} onChange={onDomainsText} />
        <div>
          <Button type="submit" variant="primary" disabled={!domains}>
            <Search />
            Show listings
          </Button>
        </div>
      </form>

      <section aria-label="Marketplaces">
        <SectionTitle>Marketplaces</SectionTitle>
        {sources.isPending ? (
          <SkeletonRows rows={3} />
        ) : sources.isError ? (
          <ErrorState error={sources.error} onRetry={() => sources.refetch()} />
        ) : (
          <div className="grid gap-8 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Lookups supported</p>
              {supported.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {supported.map((source) => (
                    <li key={source.id}>
                      <label htmlFor={`am-${source.id}`} className="flex min-h-9 items-center gap-3 rounded-md px-2 text-sm hover:bg-hover">
                        <Checkbox
                          id={`am-${source.id}`}
                          checked={chosen.has(source.id)}
                          onCheckedChange={(value) =>
                            setChosen((current) => {
                              const next = new Set(current);
                              if (value === true) next.add(source.id);
                              else next.delete(source.id);
                              return next;
                            })
                          }
                        />
                        <span className="flex-1">{source.name}</span>
                        {source.requiresCredentials ? <span className="text-xs text-muted-foreground">Needs credentials</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Link only</p>
              {linkOnly.length === 0 ? (
                <p className="text-sm text-muted-foreground">None.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {linkOnly.map((source) => (
                    <li key={source.id} className="px-2">
                      {source.name}
                      {source.reason ? <span className="block text-xs text-muted-foreground">{source.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        {selected.length > 0 && domains ? (
          <Disclosure>
            Sends {plural(domains.length, 'domain name')} to {joinNames(selected.map((s) => s.name))}.
          </Disclosure>
        ) : null}
        <div className="mt-4">
          <Button variant="secondary" disabled={!domains || selected.length === 0 || lookup.isPending} onClick={() => lookup.mutate()}>
            Look up listings
          </Button>
        </div>
      </section>

      {submitted ? (
        <section aria-label="Listings" className="flex flex-col gap-8">
          <SectionTitle className="mb-0">Listings</SectionTitle>
          {submitted.map((domain) => (
            <DomainListings key={domain} domain={domain} linkOnly={linkOnly} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
