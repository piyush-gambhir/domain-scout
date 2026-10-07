'use client';

import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Bookmark, ClockFading, Moon, PanelLeft, Plus, Search, Sparkles, Sun, SunMoon } from 'lucide-react';
import { api } from '@/lib/api';
import { PEOPLE_ORIGINS } from '@/lib/history';
import { qk, useCollections } from '@/lib/queries';
import { useThemePreference } from '@/lib/theme';
import { Kbd } from '../ui/kbd';
import { ALL_NAV_ITEMS } from './nav';

const itemClass =
  'flex h-9 cursor-default select-none items-center gap-3 rounded-md px-2 text-sm outline-none data-[selected=true]:bg-hover data-[disabled=true]:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';

function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

function Shortcut({ keys }: { keys: string[] }) {
  return (
    <span className="ml-auto flex gap-1">
      {keys.map((key) => (
        <Kbd key={key}>{key}</Kbd>
      ))}
    </span>
  );
}

/**
 * Cmd/Ctrl+K palette for navigation and quick actions. It is also the only place keyboard
 * shortcuts are documented.
 */
export function CommandPalette({
  open,
  onOpenChange,
  onToggleSidebar,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggleSidebar: () => void;
}) {
  const router = useRouter();
  const { setTheme } = useThemePreference();
  const mod = isMac() ? '⌘' : 'Ctrl';
  const recent = useQuery({
    queryKey: qk.history({ origins: PEOPLE_ORIGINS, type: 'registry_scan', limit: 6 }),
    queryFn: ({ signal }) => api.call('listHistory', { query: { origins: PEOPLE_ORIGINS, type: 'registry_scan', limit: 6 }, signal }).then((r) => r.data),
    enabled: open,
  });
  const collections = useCollections(open);

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };
  const go = (href: string) => run(() => router.push(href));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="anim-fade fixed inset-0 z-50 bg-overlay" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="anim-fade fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl bg-popover shadow-2xl outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <Command loop label="Command palette">
            <div className="flex items-center gap-3 px-4">
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <Command.Input
                placeholder="Go to a page or run a command"
                className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <Command.List className="max-h-[min(60vh,28rem)] overflow-y-auto px-2 pb-2">
              <Command.Empty className="py-8 text-center text-sm text-muted-foreground">No matches.</Command.Empty>

              <Command.Group heading="Go to">
                {ALL_NAV_ITEMS.map((item) => (
                  <Command.Item key={item.href} value={`go ${item.label}`} className={itemClass} onSelect={() => go(item.href)}>
                    <item.icon aria-hidden />
                    {item.label}
                  </Command.Item>
                ))}
              </Command.Group>

              <Command.Group heading="Actions">
                <Command.Item value="new search" className={itemClass} onSelect={() => go('/')}>
                  <Plus aria-hidden />
                  New search
                </Command.Item>
                <Command.Item value="name ideas keywords" className={itemClass} onSelect={() => go('/?mode=ideas')}>
                  <Sparkles aria-hidden />
                  Name ideas
                </Command.Item>
                <Command.Item value="toggle sidebar" className={itemClass} onSelect={() => run(onToggleSidebar)}>
                  <PanelLeft aria-hidden />
                  Toggle sidebar
                  <Shortcut keys={[mod, 'B']} />
                </Command.Item>
                <Command.Item value="theme light" className={itemClass} onSelect={() => run(() => setTheme('light'))}>
                  <Sun aria-hidden />
                  Light theme
                </Command.Item>
                <Command.Item value="theme dark" className={itemClass} onSelect={() => run(() => setTheme('dark'))}>
                  <Moon aria-hidden />
                  Dark theme
                </Command.Item>
                <Command.Item value="theme system" className={itemClass} onSelect={() => run(() => setTheme('system'))}>
                  <SunMoon aria-hidden />
                  System theme
                </Command.Item>
              </Command.Group>

              {recent.data && recent.data.length > 0 ? (
                <Command.Group heading="Recent searches">
                  {recent.data.map((entry) => (
                    <Command.Item key={entry.jobId} value={`search ${entry.label ?? ''} ${entry.jobId}`} className={itemClass} onSelect={() => go(`/search/${entry.jobId}`)}>
                      <ClockFading aria-hidden />
                      <span className="truncate">{entry.label ?? `${entry.total} names`}</span>
                      <span className="ml-auto text-xs text-muted-foreground tabular">{entry.total}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {collections.data && collections.data.length > 0 ? (
                <Command.Group heading="Saved lists">
                  {collections.data.slice(0, 8).map((collection) => (
                    <Command.Item key={collection.id} value={`saved list ${collection.name}`} className={itemClass} onSelect={() => go(`/saved/${collection.id}`)}>
                      <Bookmark aria-hidden />
                      <span className="truncate">{collection.name}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              <Command.Group heading="Keyboard shortcuts">
                <Command.Item value="shortcut command palette" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Command palette
                  <Shortcut keys={[mod, 'K']} />
                </Command.Item>
                <Command.Item value="shortcut toggle sidebar" className={itemClass} onSelect={() => run(onToggleSidebar)}>
                  Collapse or expand sidebar
                  <Shortcut keys={[mod, 'B']} />
                </Command.Item>
                <Command.Item value="shortcut focus search" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Focus the search bar
                  <Shortcut keys={['/']} />
                </Command.Item>
                <Command.Item value="shortcut move between results" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Move between results
                  <Shortcut keys={['↑', '↓', '←', '→']} />
                </Command.Item>
                <Command.Item value="shortcut open details" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Open details
                  <Shortcut keys={['↵']} />
                </Command.Item>
                <Command.Item value="shortcut save result" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Save or unsave a name
                  <Shortcut keys={['S']} />
                </Command.Item>
                <Command.Item value="shortcut buy result" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Buy: prices and provider links
                  <Shortcut keys={['B']} />
                </Command.Item>
                <Command.Item value="shortcut watch result" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Watch a name
                  <Shortcut keys={['W']} />
                </Command.Item>
                <Command.Item value="shortcut select result" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Select a result in a long list
                  <Shortcut keys={['X']} />
                </Command.Item>
                <Command.Item value="shortcut select range" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Select a range of results
                  <Shortcut keys={['Shift', 'Click']} />
                </Command.Item>
                <Command.Item value="shortcut close panel" className={itemClass} onSelect={() => onOpenChange(false)}>
                  Close panel or dialog
                  <Shortcut keys={['Esc']} />
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
