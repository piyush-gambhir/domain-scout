'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PanelLeftClose, PanelLeftOpen, Search, SunMoon } from 'lucide-react';
import { useUnreadNoticeCount } from '@/lib/queries';
import { type ThemeChoice, useThemePreference } from '@/lib/theme';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Tooltip } from '../ui/tooltip';
import { NAV_GROUPS, SETTINGS_ITEM, isActive, type NavItem } from './nav';

const itemClass =
  'relative flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-foreground aria-[current=page]:bg-sidebar-active aria-[current=page]:font-medium aria-[current=page]:text-foreground rail:justify-center rail:px-0 [&_svg]:size-4 [&_svg]:shrink-0';

function NavLink({ item, rail, badge, onNavigate }: { item: NavItem; rail: boolean; badge?: number; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = isActive(item, pathname);
  const Icon = item.icon;
  return (
    <Tooltip content={item.label} side="right" disabled={!rail}>
      <Link href={item.href} aria-current={active ? 'page' : undefined} className={itemClass} onClick={onNavigate}>
        <Icon aria-hidden />
        <span className="truncate rail:sr-only">{item.label}</span>
        {badge ? (
          <span className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium leading-[18px] text-primary-foreground tabular rail:absolute rail:right-1.5 rail:top-1 rail:ml-0 rail:px-1 rail:text-[10px] rail:leading-[14px]">
            {badge > 99 ? '99+' : badge}
            <span className="sr-only"> unread</span>
          </span>
        ) : null}
      </Link>
    </Tooltip>
  );
}

function ThemeMenu({ rail }: { rail: boolean }) {
  const { theme, setTheme } = useThemePreference();
  return (
    <DropdownMenu>
      <Tooltip content="Theme" side="right" disabled={!rail}>
        <DropdownMenuTrigger className={itemClass}>
          <SunMoon aria-hidden />
          <span className="truncate rail:sr-only">Theme</span>
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
  onOpenPalette,
  footerExtra,
}: {
  rail: boolean;
  onNavigate?: () => void;
  onOpenPalette: () => void;
  footerExtra?: React.ReactNode;
}) {
  const unread = useUnreadNoticeCount();
  return (
    <>
      <Brand />
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 pb-4 pt-2">
        {NAV_GROUPS.map((group, index) => (
          <ul key={index} className="flex flex-col gap-0.5">
            {group.map((item) => (
              <li key={item.href}>
                <NavLink item={item} rail={rail} onNavigate={onNavigate} badge={item.href === '/monitoring' ? unread : undefined} />
              </li>
            ))}
          </ul>
        ))}
      </nav>
      <div className="flex flex-col gap-0.5 px-2 pb-3">
        <Tooltip content="Search" side="right" disabled={!rail}>
          <button type="button" className={itemClass} onClick={onOpenPalette}>
            <Search aria-hidden />
            <span className="truncate rail:sr-only">Search</span>
          </button>
        </Tooltip>
        <NavLink item={SETTINGS_ITEM} rail={rail} onNavigate={onNavigate} />
        <ThemeMenu rail={rail} />
        {footerExtra}
      </div>
    </>
  );
}

export function DesktopSidebar({
  collapsed,
  onToggle,
  onOpenPalette,
}: {
  collapsed: boolean;
  onToggle: () => void;
  onOpenPalette: () => void;
}) {
  return (
    <aside
      data-testid="sidebar"
      data-state={collapsed ? 'collapsed' : 'expanded'}
      className="sidebar-rail sticky top-0 hidden h-dvh w-[var(--sidebar-width)] shrink-0 flex-col bg-sidebar transition-[width] duration-150 ease-out motion-reduce:transition-none md:flex"
    >
      <SidebarNav
        rail={collapsed}
        onOpenPalette={onOpenPalette}
        footerExtra={
          <Tooltip content="Expand sidebar" side="right" disabled={!collapsed}>
            <button type="button" className={cn(itemClass)} onClick={onToggle} aria-expanded={!collapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
              {collapsed ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
              <span className="truncate rail:sr-only">Collapse</span>
            </button>
          </Tooltip>
        }
      />
    </aside>
  );
}
