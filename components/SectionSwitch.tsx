'use client';

import Link from 'next/link';
import type { Section } from '@/lib/nav';

const OPTIONS = [
  { section: 'books', href: '/', label: 'Books' },
  { section: 'screen', href: '/screen', label: 'Screen' },
] as const;

/** Books | Screen (spec §7.1, §7.11). Short labels so it fits beside the wordmark at 390 px. */
export default function SectionSwitch({
  active,
  className = '',
}: {
  active: Section;
  className?: string;
}) {
  return (
    <nav
      aria-label="Section"
      className={[
        'inline-flex shrink-0 rounded-lg border border-border bg-elevated p-0.5',
        className,
      ].join(' ')}
    >
      {OPTIONS.map((o) => {
        const current = o.section === active;
        return (
          <Link
            key={o.section}
            href={o.href}
            aria-current={current ? 'true' : undefined}
            className={[
              'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              current ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
            ].join(' ')}
          >
            {o.label}
          </Link>
        );
      })}
    </nav>
  );
}
