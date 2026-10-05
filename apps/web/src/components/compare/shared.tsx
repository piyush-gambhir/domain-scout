'use client';

import { ChevronDown, ExternalLink } from 'lucide-react';
import { parseDomains } from '@/lib/domains';
import { plural } from '@/lib/format';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Textarea } from '../ui/input';
import { Field } from '../ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

export const MAX_COMPARE_DOMAINS = 500;

/** Domains typed or prefilled for the compare tabs, with parse feedback. */
export function DomainsField({ value, onChange, max = MAX_COMPARE_DOMAINS }: { value: string; onChange: (value: string) => void; max?: number }) {
  const parsed = parseDomains(value);
  const tooMany = parsed.valid.length > max;
  return (
    <Field
      label="Domains"
      htmlFor="compare-domains"
      hint={
        parsed.invalid.length ? (
          <span className="text-negative">
            Not a domain: {parsed.invalid.slice(0, 5).join(', ')}
            {parsed.invalid.length > 5 ? ` and ${parsed.invalid.length - 5} more` : ''}
          </span>
        ) : tooMany ? (
          <span className="text-negative">At most {max} domains.</span>
        ) : (
          plural(parsed.valid.length, 'domain')
        )
      }
    >
      <Textarea
        id="compare-domains"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        aria-invalid={parsed.invalid.length > 0 || tooMany || undefined}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-20 font-mono text-[13px]"
      />
    </Field>
  );
}

export function usableDomains(text: string, max = MAX_COMPARE_DOMAINS): string[] | null {
  const parsed = parseDomains(text);
  if (parsed.valid.length === 0 || parsed.invalid.length > 0 || parsed.valid.length > max) return null;
  return parsed.valid;
}

/** Multi-select of providers; an empty selection means every provider. */
export function ProviderFilter({
  providers,
  value,
  onChange,
}: {
  providers: { id: string; name: string }[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const selected = new Set(value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={selected.size ? 'primary' : 'secondary'} className="justify-between" aria-label="Providers">
          {selected.size ? plural(selected.size, 'provider') : 'All providers'}
          <ChevronDown className="opacity-70" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1">
        <ul className="flex flex-col">
          {providers.map((provider) => {
            const id = `pf-${provider.id}`;
            return (
              <li key={provider.id}>
                <label htmlFor={id} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-sm hover:bg-hover">
                  <Checkbox
                    id={id}
                    checked={selected.has(provider.id)}
                    onCheckedChange={(checked) => {
                      const next = new Set(selected);
                      if (checked === true) next.add(provider.id);
                      else next.delete(provider.id);
                      onChange([...next]);
                    }}
                  />
                  <span className="truncate">{provider.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {selected.size ? (
          <Button size="sm" variant="quiet" className="mt-1 w-full" onClick={() => onChange([])}>
            All providers
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** External purchase or listing link for one named provider. */
export function OutLink({ href, label, provider }: { href: string; label: string; provider: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 whitespace-nowrap underline-offset-4 hover:underline">
      {label}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only"> at {provider} (opens in a new tab)</span>
    </a>
  );
}
