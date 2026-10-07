import { Bookmark, ClockFading, Eye, Search, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra path prefixes that mark this item active. */
  match?: string[];
}

/** The four things a person comes to do, in the order they do them. */
export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Search', icon: Search, match: ['/search', '/domains'] },
  { href: '/saved', label: 'Saved', icon: Bookmark },
  { href: '/watching', label: 'Watching', icon: Eye },
  { href: '/history', label: 'History', icon: ClockFading },
];

export const SETTINGS_ITEM: NavItem = { href: '/settings', label: 'Settings', icon: Settings };

export const ALL_NAV_ITEMS: NavItem[] = [...NAV_ITEMS, SETTINGS_ITEM];

export function isActive(item: NavItem, pathname: string): boolean {
  if (pathname === item.href) return true;
  const prefixes = [...(item.href === '/' ? [] : [item.href]), ...(item.match ?? [])];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
