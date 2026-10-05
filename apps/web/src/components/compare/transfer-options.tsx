'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { Money } from '@domain-scout/contracts';
import { api } from '@/lib/api';
import { PRICE_KIND } from '@/lib/labels';
import { formatMoney, plural } from '@/lib/format';
import { qk, useProviders } from '@/lib/queries';
import { CheckedAt } from '../domain/time';
import { ErrorState, SectionTitle } from '../states';
import { SkeletonRows } from '../ui/skeleton';
import { OutLink } from './shared';

const thClass = 'pb-1.5 pr-3 text-left text-xs font-medium text-muted-foreground';
const tdClass = 'py-1.5 pr-3 align-top';

function Amount({ money }: { money: Money | null }) {
  return money ? <span className="font-mono tabular">{formatMoney(money.amount, money.currency)}</span> : <span className="text-muted-foreground">Unknown</span>;
}

/** Read-only transfer options for one domain from retained data. No transfer or authorization step happens here. */
function DomainTransferOptions({ domain, names }: { domain: string; names: Map<string, string> }) {
  const options = useQuery({
    queryKey: qk.transferOptions(domain),
    queryFn: ({ signal }) => api.call('listDomainTransferOptions', { params: { name: domain }, query: { limit: 100 }, signal }).then((r) => r.data),
  });
  return (
    <section aria-label={`Transfer options for ${domain}`} data-testid="transfer-options">
      <h4 className="mb-2 font-mono text-sm font-semibold">
        <Link href={`/domains/${encodeURIComponent(domain)}`} className="underline-offset-4 hover:underline">
          {domain}
        </Link>
      </h4>
      {options.isPending ? (
        <SkeletonRows rows={2} />
      ) : options.isError ? (
        <ErrorState error={options.error} onRetry={() => options.refetch()} />
      ) : options.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No retained transfer prices.</p>
      ) : (
        <div className="relative -mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[36rem] table-fixed text-left text-sm">
            <colgroup>
              <col className="w-[22%]" />
              <col className="w-[18%]" />
              <col className="w-[14%]" />
              <col className="w-[16%]" />
              <col />
            </colgroup>
            <thead>
              <tr>
                {['Provider', 'Transfer', 'Renewal', 'Observed', 'Eligibility'].map((h) => (
                  <th key={h} scope="col" className={thClass}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {options.data.map((option) => {
                const name = names.get(option.providerId) ?? option.providerId;
                return (
                  <tr key={`${option.providerId}-${option.observedAt}`}>
                    <td className={tdClass}>
                      <span className="block truncate font-medium">{name}</span>
                      <span className="block text-xs text-muted-foreground">{PRICE_KIND[option.kind]}</span>
                      {option.destination ? (
                        <span className="block text-xs">
                          <OutLink href={option.destination} label="Transfer page" provider={name} />
                        </span>
                      ) : null}
                    </td>
                    <td className={tdClass}>
                      <Amount money={option.transfer} />
                      <span className="block text-xs text-muted-foreground">
                        {option.includesYears === null ? 'Included term unknown' : option.includesYears === 0 ? 'No year included' : `Includes ${plural(option.includesYears, 'year')}`}
                      </span>
                    </td>
                    <td className={tdClass}>
                      <Amount money={option.renewal} />
                    </td>
                    <td className={tdClass}>
                      <CheckedAt iso={option.observedAt} freshness={option.freshness} />
                    </td>
                    <td className={tdClass}>
                      {option.eligibility.known.length ? (
                        <ul className="font-mono text-xs">
                          {option.eligibility.known.map((fact) => (
                            <li key={fact} className="break-all">
                              {fact}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span className="block text-xs text-muted-foreground">None known</span>
                      )}
                      {option.eligibility.unknown.length ? (
                        <ul className="mt-0.5 text-xs text-muted-foreground">
                          {option.eligibility.unknown.map((fact) => (
                            <li key={fact}>Unknown: {fact}</li>
                          ))}
                        </ul>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function TransferOptions({ domains }: { domains: string[] }) {
  const providers = useProviders();
  const names = new Map((providers.data ?? []).map((p) => [p.id, p.name]));
  return (
    <section aria-label="Transfer options" className="flex flex-col gap-6">
      <SectionTitle className="mb-0">Transfer options</SectionTitle>
      {domains.map((domain) => (
        <DomainTransferOptions key={domain} domain={domain} names={names} />
      ))}
    </section>
  );
}
