'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen, SunMoon } from 'lucide-react';
import { useCollections, useUnreadNoticeCount } from '@/lib/queries';
import { type ThemeChoice, useThemePreference } from '@/lib/theme';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Tooltip } from '../ui/tooltip';
import { NAV_ITEMS, SETTINGS_ITEM, isActive, type NavItem } from './nav';

const itemClass =
  'relative flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-foreground aria-[current=page]:bg-sidebar-active aria-[current=page]:font-medium aria-[current=page]:text-foreground rail:justify-center rail:px-0 [&_svg]:size-4 [&_svg]:shrink-0';

interface Badge {
  count: number;
  /** Unread counts are filled; plain counts stay quiet text. */
  unread?: boolean;
  label: string;
}

function NavLink({ item, rail, badge, onNavigate }: { item: NavItem; rail: boolean; badge?: Badge; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = isActive(item, pathname);
  const Icon = item.icon;
  const shown = badge && badge.count > 0 ? (badge.count > 999 ? '999+' : String(badge.count)) : null;
  return (
    <Tooltip content={item.label} side="right" disabled={!rail}>
      <Link href={item.href} aria-current={active ? 'page' : undefined} className={itemClass} onClick={onNavigate}>
        <Icon aria-hidden />
        <span className="truncate rail:sr-only">{item.label}</span>
        {shown && badge?.unread ? (
          <span className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium leading-[18px] text-primary-foreground tabular rail:absolute rail:right-1.5 rail:top-1 rail:ml-0 rail:px-1 rail:text-[10px] rail:leading-[14px]">
            {shown}
            <span className="sr-only"> {badge.label}</span>
          </span>
        ) : shown ? (
          <span className="ml-auto text-xs text-muted-foreground tabular rail:sr-only">
            {shown}
            <span className="sr-only"> {badge?.label}</span>
          </span>
        ) : null}
      </Link>
    </Tooltip>
  );
}

const smallControl =
  'grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-foreground data-[state=open]:bg-sidebar-hover [&_svg]:size-4';

function ThemeMenu() {
  const { theme, setTheme } = useThemePreference();
  return (
    <DropdownMenu>
      <Tooltip content="Theme">
        <DropdownMenuTrigger className={smallControl} aria-label="Theme">
          <SunMoon aria-hidden />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" className="min-w-36">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => setTheme(value as ThemeChoice)}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2.5 px-2.5 rail:justify-center rail:px-0">
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-primary font-mono text-[11px] font-bold text-primary-foreground">
        ds
      </span>
      <span className="truncate text-sm font-semibold tracking-tight rail:sr-only">Domain Scout</span>
    </div>
  );
}

/** Navigation body shared by the desktop sidebar and the mobile drawer. */
export function SidebarNav({
  rail,
  onNavigate,
  footerExtra,
}: {
  rail: boolean;
  onNavigate?: () => void;
  footerExtra?: React.ReactNode;
}) {
  const unread = useUnreadNoticeCount();
  const collections = useCollections();
  const saved = (collections.data ?? []).reduce((sum, c) => sum + c.entryCount, 0);
  const badges: Record<string, Badge> = {
    '/saved': { count: saved, label: 'saved' },
    '/watching': { count: unread, unread: true, label: 'unread' },
  };
  return (
    <>
      <Brand />
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4 pt-2">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.href}>
              <NavLink item={item} rail={rail} onNavigate={onNavigate} badge={badges[item.href]} />
            </li>
          ))}
        </ul>
      </nav>
      <div className="flex flex-col gap-1 px-2 pb-3">
        <NavLink item={SETTINGS_ITEM} rail={rail} onNavigate={onNavigate} />
        <div className="flex items-center gap-0.5 px-0.5 rail:flex-col">
          <ThemeMenu />
          {footerExtra}
        </div>
      </div>
    </>
  );
}

export function DesktopSidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <aside
      data-testid="sidebar"
      data-state={collapsed ? 'collapsed' : 'expanded'}
      className="sidebar-rail sticky top-0 hidden h-dvh w-[var(--sidebar-width)] shrink-0 flex-col bg-sidebar transition-[width] duration-150 ease-out motion-reduce:transition-none md:flex"
    >
      <SidebarNav
        rail={collapsed}
        footerExtra={
          <Tooltip content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <button type="button" className={smallControl} onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            </button>
          </Tooltip>
        }
      />
    </aside>
  );
}
