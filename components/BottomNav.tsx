'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navRoutesFor, sectionFor } from '@/lib/nav';

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base';

export default function BottomNav() {
  const pathname = usePathname();
  const links = navRoutesFor(sectionFor(pathname)).filter((r) => r.primary);

  return (
    <nav
      aria-label="Main navigation"
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-base lg:hidden"
    >
      <div className="flex items-stretch pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {links.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={[
                'flex flex-1 flex-col items-center gap-1 px-1 py-3 text-center transition-colors',
                focusRing,
                active ? 'text-accent' : 'text-muted hover:text-text',
              ].join(' ')}
            >
              {/* The current tab gets the rail's filled pill and a heavier label, so it is
                  not marked by hue alone (accent and muted sit at near-equal lightness). */}
              <span
                className={[
                  'flex items-center justify-center rounded-full px-3 py-0.5',
                  active ? 'bg-elevated' : '',
                ].join(' ')}
              >
                <Icon size={20} aria-hidden="true" />
              </span>
              <span className={['text-xs', active ? 'font-semibold' : 'font-medium'].join(' ')}>
                {label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
