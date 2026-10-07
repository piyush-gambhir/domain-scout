'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Command, Menu, X } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import { useSessionRequired } from '@/lib/session';
import { ThemeSync } from '@/lib/theme';
import { Button } from '../ui/button';
import { CommandPalette } from './command-palette';
import { SessionRequired } from './session-required';
import { DesktopSidebar, SidebarNav } from './sidebar';
import { toggleSidebar, useSidebarCollapsed } from './sidebar-state';

/** Cmd+B means bold in rich text editors; leave those alone. */
function isRichText(target: EventTarget | null) {
  return target instanceof HTMLElement && target.isContentEditable;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const sessionRequired = useSessionRequired();
  const collapsed = useSidebarCollapsed();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Probe the session once so a missing session shows the session screen immediately.
  // A 401 marks the session required (QueryCache handler); other errors are ignored here.
  useQuery({
    queryKey: qk.session,
    queryFn: ({ signal }) => api.call('getSession', { signal }).then((r) => r.data),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === 'b' && !isRichText(event.target)) {
        event.preventDefault();
        if (window.matchMedia('(min-width: 768px)').matches) toggleSidebar();
        else setDrawerOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (sessionRequired) return <SessionRequired />;

  const toggle = () => {
    if (window.matchMedia('(min-width: 768px)').matches) toggleSidebar();
    else setDrawerOpen((open) => !open);
  };

  // At lg and up the shell is exactly the window and never scrolls as a document; pages fill <main>
  // and only their growing-data panes scroll. Below lg the page scrolls normally where it must.
  return (
    <div data-shell className="flex min-h-dvh lg:h-dvh lg:overflow-hidden">
      <a
        href="#main"
        className="fixed left-3 top-3 z-[60] -translate-y-20 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:translate-y-0"
      >
        Skip to content
      </a>

      <DesktopSidebar collapsed={collapsed} onToggle={toggleSidebar} />

      <div className="flex min-w-0 flex-1 flex-col lg:min-h-0">
        <div className="sticky top-0 z-30 flex h-12 items-center gap-1 bg-background/90 px-2 backdrop-blur md:hidden">
          <DialogPrimitive.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <DialogPrimitive.Trigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open navigation">
                <Menu />
              </Button>
            </DialogPrimitive.Trigger>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="anim-fade fixed inset-0 z-50 bg-overlay" />
              <DialogPrimitive.Content
                aria-describedby={undefined}
                className="anim-drawer fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar shadow-2xl outline-none"
              >
                <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
                <DialogPrimitive.Close asChild>
                  <Button variant="quiet" size="icon-sm" aria-label="Close navigation" className="absolute right-2 top-3">
                    <X />
                  </Button>
                </DialogPrimitive.Close>
                <SidebarNav rail={false} onNavigate={() => setDrawerOpen(false)} />
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>
          <span className="text-sm font-semibold tracking-tight">Domain Scout</span>
          <Button variant="ghost" size="icon" aria-label="Commands" className="ml-auto" onClick={() => setPaletteOpen(true)}>
            <Command />
          </Button>
        </div>

        <main id="main" tabIndex={-1} className="relative flex min-w-0 flex-1 flex-col outline-none lg:min-h-0 lg:overflow-y-auto">
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onToggleSidebar={toggle} />
      <ThemeSync />
    </div>
  );
}
