'use client';

import Link from 'next/link';
import { ExternalLink, ShoppingBag } from 'lucide-react';
import { DESTINATION_NOTE } from '@/lib/labels';
import { formatMoney, plural } from '@/lib/format';
import { type PriceLine, buyUrl, linkOnlyProviders } from '@/lib/prices';
import { useProviders } from '@/lib/queries';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGap,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

function Amount({ value, currency, strong, years = 1 }: { value: string | null; currency: string; strong?: boolean; years?: number }) {
  if (value === null) return <span className="text-muted-foreground">Unknown</span>;
  return (
    <span className={cn('tabular', strong && 'font-medium')}>
      {formatMoney(value, currency)}
      {years > 1 ? <span className="text-[11px] font-normal text-muted-foreground"> /{years} yr</span> : null}
    </span>
  );
}

const GRID = 'grid w-full grid-cols-[minmax(7rem,1fr)_4.75rem_4.75rem_5.25rem_1rem] items-center gap-x-3';

/**
 * Where to buy a name: each provider's first-year price, renewal and horizon estimate with a link to
 * the same provider's registration page. Registrars without a published price, and the registry's
 * own registrar list, sit in collapsed groups below.
 */
export function BuyMenu({
  domain,
  suffix,
  lines,
  horizon,
  open,
  onOpenChange,
  trigger,
  align = 'end',
  returnFocus,
}: {
  /** Where focus goes when the menu closes, e.g. the row or cell it was opened from by keyboard. */
  returnFocus?: () => HTMLElement | null | undefined;
  domain: string;
  suffix: string;
  lines: PriceLine[];
  horizon: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: React.ReactNode;
  align?: 'start' | 'end';
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-[28rem] max-w-[calc(100vw-2rem)]"
        aria-label={`Buy ${domain}`}
        onCloseAutoFocus={(event) => {
          const target = returnFocus?.();
          if (target) {
            event.preventDefault();
            target.focus({ preventScroll: true });
          }
        }}
      >
        {open !== false ? <BuyMenuBody domain={domain} suffix={suffix} lines={lines} horizon={horizon} /> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BuyMenuBody({ domain, suffix, lines, horizon }: { domain: string; suffix: string; lines: PriceLine[]; horizon: number }) {
  const providers = useProviders();
  const priced = new Set(lines.map((l) => l.providerId));
  const others = linkOnlyProviders(providers.data, suffix, priced);
  return (
    <>
      <DropdownMenuLabel className="flex items-baseline justify-between gap-3 pt-1.5">
        <span className="truncate font-mono text-foreground">{domain}</span>
      </DropdownMenuLabel>
      {lines.length ? (
        <div className={cn(GRID, 'px-2 pb-1 text-[11px] text-muted-foreground')} aria-hidden>
          <span>Provider</span>
          <span className="text-right">First year</span>
          <span className="text-right">Renews</span>
          <span className="text-right">{horizon} years</span>
          <span />
        </div>
      ) : (
        <p className="px-2 py-2 text-sm text-muted-foreground">
          No provider price is known for .{suffix}.{' '}
          <Link href="/settings/providers" className="text-foreground underline underline-offset-4">
            Providers
          </Link>
        </p>
      )}
      {lines.map((line) =>
        line.url ? (
          <DropdownMenuItem key={line.providerId} asChild className="h-9">
            <a href={line.url} target="_blank" rel="noopener noreferrer" data-testid="buy-link" aria-label={`Buy at ${line.providerName}, ${line.firstYear ? formatMoney(line.firstYear, line.currency) : 'price unknown'} first year`}>
              <span className={GRID}>
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate">{line.providerName}</span>
                  {line.kind === 'exact_quote' ? <span className="text-[11px] text-muted-foreground">Quote{line.freshness !== 'fresh' ? ', older' : ''}</span> : null}
                  {line.minYears ? <span className="text-[11px] text-muted-foreground">{line.minYears} yr minimum</span> : null}
                  {line.promotional ? (
                    <span className="text-[11px] text-muted-foreground" title={line.promotionNote ?? undefined}>
                      Promo{line.promotionNote ? ` (${line.promotionNote})` : ''}
                    </span>
                  ) : null}
                </span>
                <span className="text-right">
                  <Amount value={line.firstYear} currency={line.currency} strong years={line.firstYearTerm} />
                </span>
                <span className="text-right text-muted-foreground">
                  <Amount value={line.renewal} currency={line.currency} years={line.renewalTerm} />
                </span>
                <span className="text-right text-muted-foreground">
                  <Amount value={line.horizonTotal} currency={line.currency} />
                </span>
                <ExternalLink className="size-3.5 text-muted-foreground" aria-hidden />
              </span>
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem key={line.providerId} disabled className="h-9">
            <span className={GRID}>
              <span className="truncate">{line.providerName}</span>
              <span className="text-right">
                <Amount value={line.firstYear} currency={line.currency} years={line.firstYearTerm} />
              </span>
              <span className="text-right">
                <Amount value={line.renewal} currency={line.currency} years={line.renewalTerm} />
              </span>
              <span className="text-right">
                <Amount value={line.horizonTotal} currency={line.currency} />
              </span>
              <span />
            </span>
          </DropdownMenuItem>
        ),
      )}
      {others.named.length || others.directory.length ? <DropdownMenuGap /> : null}
      {others.named.length ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="truncate">Other registrars</span>
            <span className="ml-auto text-xs text-muted-foreground tabular">{others.named.length}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            {others.named.map((provider) => (
              <ProviderLink key={provider.id} name={provider.name} url={buyUrl(provider.purchaseLink?.template, domain)} kind={provider.purchaseLink?.kind ?? null} />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {others.directory.length ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="truncate">
              {plural(others.directory.length, others.named.length ? 'more accredited seller' : 'accredited seller')} listed by the registry
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 w-72">
            {others.directory.map((provider) => (
              <ProviderLink key={provider.id} name={provider.name} url={buyUrl(provider.purchaseLink?.template, domain)} kind={provider.purchaseLink?.kind ?? 'website'} />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {lines.length ? <p className="px-2 pb-1.5 pt-2 text-[11px] text-muted-foreground">Published prices. Premium names and taxes can differ.</p> : null}
    </>
  );
}

function ProviderLink({ name, url, kind }: { name: string; url: string | null; kind: string | null }) {
  if (!url) {
    return (
      <DropdownMenuItem disabled>
        <span className="truncate">{name}</span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem asChild>
      <a href={url} target="_blank" rel="noopener noreferrer">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="text-xs text-muted-foreground">{kind === 'website' ? 'Website' : kind === 'dashboard' ? 'Sign in' : 'Open'}</span>
        <ExternalLink className="text-muted-foreground" aria-hidden />
        {kind && DESTINATION_NOTE[kind] ? <span className="sr-only">, {DESTINATION_NOTE[kind]}</span> : null}
      </a>
    </DropdownMenuItem>
  );
}

export function BuyIcon() {
  return <ShoppingBag aria-hidden />;
}
