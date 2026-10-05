'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Menu, Search, X } from 'lucide-react';
import { api } from '@/lib/api';
import { qk } from '@/lib/queries';
import { useSessionRequired } from '@/lib/session';
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

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="fixed left-3 top-3 z-[60] -translate-y-20 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:translate-y-0"
      >
        Skip to content
      </a>

      <DesktopSidebar collapsed={collapsed} onToggle={toggleSidebar} onOpenPalette={() => setPaletteOpen(true)} />

      <div className="flex min-w-0 flex-1 flex-col">
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
                <SidebarNav
                  rail={false}
                  onNavigate={() => setDrawerOpen(false)}
                  onOpenPalette={() => {
                    setDrawerOpen(false);
                    setPaletteOpen(true);
                  }}
                />
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>
          <span className="text-sm font-semibold tracking-tight">Domain Scout</span>
          <Button variant="ghost" size="icon" aria-label="Search" className="ml-auto" onClick={() => setPaletteOpen(true)}>
            <Search />
          </Button>
        </div>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 pb-24 pt-6 outline-none md:px-8 md:pt-8">
          {children}
        </main>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onToggleSidebar={toggle} />
    </div>
  );
}
