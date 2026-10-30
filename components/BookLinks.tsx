import { ExternalLink } from 'lucide-react';
import {
  AFFILIATE_DISCLOSURE,
  bookLinks,
  type BookLink,
  type BookLinkInput,
} from '@/lib/bookLinks';

/** The outbound links for one book, as small pill links. */
export function BookLinkPills({ links, size = 'md' }: { links: BookLink[]; size?: 'sm' | 'md' }) {
  return (
    <>
      {links.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          // An affiliate link is marked sponsored for search engines, per Google's guidance.
          rel={link.affiliate ? 'sponsored noopener noreferrer' : 'noopener noreferrer'}
          className={[
            'inline-flex items-center gap-1.5 rounded-full border border-border font-medium text-muted',
            size === 'sm' ? 'px-2.5 py-0.5 text-[11px]' : 'px-3 py-1 text-xs',
            'hover:border-muted hover:text-text transition',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
          ].join(' ')}
        >
          {link.label}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
        </a>
      ))}
    </>
  );
}

/** The affiliate disclosure, rendered only when some link on screen earns a commission. */
export function AffiliateNote({ show, className = '' }: { show: boolean; className?: string }) {
  if (!show) return null;
  return <p className={['text-xs text-faint', className].join(' ')}>{AFFILIATE_DISCLOSURE}</p>;
}

/**
 * Where to get a kept book: a library and a bookstore, without Amazon, for lists where a row
 * should stay quiet. The book's detail view shows the full set.
 */
export function shelfLinks(book: BookLinkInput): BookLink[] {
  return bookLinks(book).filter((l) => l.label !== 'Amazon');
}
