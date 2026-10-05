import {
  Bell,
  Bookmark,
  ClockFading,
  ListChecks,
  Plug,
  Scale,
  ScanSearch,
  Settings,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra path prefixes that mark this item active. */
  match?: string[];
}

/** Sidebar items grouped by task. Groups are separated by space, not lines. */
export const NAV_GROUPS: NavItem[][] = [
  [
    { href: '/scan', label: 'Scan', icon: ScanSearch },
    { href: '/discover', label: 'Discover', icon: Sparkles },
  ],
  [
    { href: '/jobs', label: 'Jobs', icon: ListChecks, match: ['/domains'] },
    { href: '/history', label: 'History', icon: ClockFading },
  ],
  [
    { href: '/collections', label: 'Shortlists', icon: Bookmark },
    { href: '/compare', label: 'Compare', icon: Scale },
  ],
  [
    { href: '/monitoring', label: 'Monitor', icon: Bell },
    { href: '/providers', label: 'Providers', icon: Plug },
  ],
];

export const SETTINGS_ITEM: NavItem = { href: '/settings', label: 'Settings', icon: Settings };

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_GROUPS.flat(), SETTINGS_ITEM];

export function isActive(item: NavItem, pathname: string): boolean {
  const prefixes = [item.href, ...(item.match ?? [])];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
