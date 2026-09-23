// Single source of truth for application navigation. NavBar (desktop) renders
// every route; BottomNav (mobile) renders the `primary` ones. Previously the two
// components kept separate lists, which is how /discover became unreachable on
// mobile and how "My library" and "Library" ended up naming the same route.
import {
  BookOpen,
  Clapperboard,
  Compass,
  Home,
  Settings,
  Shuffle,
  Sparkles,
  User,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavRoute {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Appears in the mobile bottom nav. Budget: 5, for thumb reach. */
  primary: boolean;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  { href: '/', label: 'Home', Icon: Home, primary: true },
  { href: '/swipe', label: 'Swipe', Icon: Shuffle, primary: true },
  { href: '/discover', label: 'Discover', Icon: Compass, primary: true },
  { href: '/library', label: 'Library', Icon: BookOpen, primary: true },
  { href: '/profile', label: 'Profile', Icon: User, primary: true },
  { href: '/settings', label: 'Settings', Icon: Settings, primary: false },
] as const;

export type Section = 'books' | 'screen';

/**
 * The active section, derived from the pathname and never stored (spec §7.1): `/screen`
 * exactly or anything under `/screen/`. `/screenings` is not the screen section.
 */
export function sectionFor(pathname: string | null): Section {
  if (pathname === '/screen' || pathname?.startsWith('/screen/')) return 'screen';
  return 'books';
}

/** The ScreenSprite nav set (spec §7.1). Settings is shared with books. */
export const SCREEN_NAV_ROUTES: readonly NavRoute[] = [
  { href: '/screen', label: 'For you', Icon: Sparkles, primary: true },
  { href: '/screen/library', label: 'Library', Icon: Clapperboard, primary: true },
  { href: '/screen/profile', label: 'Profile', Icon: User, primary: true },
  { href: '/settings', label: 'Settings', Icon: Settings, primary: false },
] as const;

export function navRoutesFor(section: Section): readonly NavRoute[] {
  return section === 'screen' ? SCREEN_NAV_ROUTES : NAV_ROUTES;
}
