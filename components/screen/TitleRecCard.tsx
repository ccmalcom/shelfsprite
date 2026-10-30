'use client';

import Link from 'next/link';
import { BookOpen, Film, Tv } from 'lucide-react';
import type { Book, TitleOut, TitleRec, Trait } from '@/lib/api';
import { Button } from '@/components/ui';
import TitleTile from '@/components/screen/TitleTile';
import { mediaLabel, titleLabel } from '@/lib/screen';
import { truncateAtWord } from '@/lib/truncate';

/** Most trait reasons a card shows; the rationale above them already says the rest. */
export const MAX_TRAIT_REASONS = 3;
/** Characters of a trait claim a chip shows before cutting at a word boundary. */
const TRAIT_LABEL_CHARS = 40;

/**
 * The cited trait ids a card shows as reasons, in citation order, at most
 * `MAX_TRAIT_REASONS`. The reranker cites aversions too ("you avoid X, and this has none"),
 * but an aversion is not a reason to watch something, so only loves the viewer still stands
 * behind show, as on the book `SwipeCard`. An id whose trait is gone stays, so the card can
 * say the evidence was removed.
 */
export function reasonTraitIds(ids: number[], traits: Map<number, Trait>): number[] {
  return ids
    .filter((id) => {
      const t = traits.get(id);
      return t === undefined || (t.polarity === 'reward' && t.status !== 'rejected');
    })
    .slice(0, MAX_TRAIT_REASONS);
}

const OUTCOME: Record<Exclude<TitleRec['status'], 'served'>, string> = {
  accepted: 'On your watchlist',
  already_watched: 'Marked as watched',
  rejected: 'Skipped',
};

const CHIP = 'inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs';
const LIVE_CHIP = [
  CHIP,
  'border-border text-muted hover:border-accent hover:text-accent',
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
].join(' ');
const GONE_CHIP = `${CHIP} border-dashed border-border text-faint`;

interface Props {
  rec: TitleRec;
  traits: Map<number, Trait>;
  titles: Map<number, TitleOut>;
  books: Map<number, Book>;
  busy: boolean;
  onAccept: () => void;
  onWatched: () => void;
  onReject: () => void;
  onOpenTitle: (t: TitleOut) => void;
  onOpenBook: (b: Book) => void;
}

/**
 * One screen recommendation (spec §7.2): tile, type, year, rationale and grounding chips. A
 * trait chip (reward traits only, at most `MAX_TRAIT_REASONS`, label cut at a word) deep-links
 * the profile row (§8); a title chip opens the title; a book chip opens the book read-only.
 * Title and book chips both carry a media icon and a screen-reader label, so a film and the
 * novel it adapts never read as the same chip. Evidence deleted since the run renders as plain
 * text. No description: the row stores no description source (§7.9).
 */
export default function TitleRecCard({
  rec,
  traits,
  titles,
  books,
  busy,
  onAccept,
  onWatched,
  onReject,
  onOpenTitle,
  onOpenBook,
}: Props) {
  const traitIds = reasonTraitIds(rec.grounded_trait_ids, traits);
  const chipCount = traitIds.length + rec.grounded_title_ids.length + rec.grounded_book_ids.length;
  const headingId = `rec-${rec.id}-title`;

  return (
    <article
      aria-labelledby={headingId}
      className="flex gap-4 rounded-2xl border border-border bg-surface p-4"
    >
      <TitleTile
        title={rec.title}
        year={rec.year}
        mediaType={rec.media_type}
        imageUrl={rec.image_url}
        className="w-24 shrink-0 sm:w-32"
        sizes="128px"
      />
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <p className="eyebrow">
            {[mediaLabel(rec.media_type), rec.year === null ? null : String(rec.year)]
              .filter((x): x is string => x !== null)
              .join(' \u00B7 ')}
          </p>
          <h3
            id={headingId}
            className="mt-1 font-display text-xl font-semibold leading-snug text-text"
          >
            {rec.title}
          </h3>
        </div>

        {rec.rationale && <p className="text-sm leading-relaxed text-muted">{rec.rationale}</p>}

        {chipCount > 0 && (
          <ul aria-label="Why this pick" className="flex flex-wrap gap-1.5">
            {traitIds.map((id) => {
              const t = traits.get(id);
              const label = t ? truncateAtWord(t.claim, TRAIT_LABEL_CHARS) : '';
              return (
                <li key={`trait-${id}`} className="min-w-0 max-w-full">
                  {t ? (
                    // The chip shows a short label; the full claim is the tooltip, the
                    // accessible name, and one tap away on the profile row it links to.
                    <Link
                      href={`/screen/profile?trait=${id}`}
                      className={LIVE_CHIP}
                      title={label === t.claim ? undefined : t.claim}
                      aria-label={t.claim}
                    >
                      <span className="truncate">{label}</span>
                    </Link>
                  ) : (
                    <span className={GONE_CHIP}>A trait no longer in your profile</span>
                  )}
                </li>
              );
            })}
            {rec.grounded_title_ids.map((id) => {
              const t = titles.get(id);
              return (
                <li key={`title-${id}`}>
                  {t ? (
                    <button type="button" onClick={() => onOpenTitle(t)} className={LIVE_CHIP}>
                      {t.media_type === 'tv' ? (
                        <Tv className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Film className="h-3 w-3" aria-hidden="true" />
                      )}
                      <span className="sr-only">{`${mediaLabel(t.media_type)}: `}</span>
                      {titleLabel(t.title, t.year)}
                    </button>
                  ) : (
                    <span className={GONE_CHIP}>A title no longer in your library</span>
                  )}
                </li>
              );
            })}
            {rec.grounded_book_ids.map((id) => {
              const b = books.get(id);
              return (
                <li key={`book-${id}`}>
                  {b ? (
                    <button type="button" onClick={() => onOpenBook(b)} className={LIVE_CHIP}>
                      <BookOpen className="h-3 w-3" aria-hidden="true" />
                      <span className="sr-only">{'Book: '}</span>
                      {b.title}
                    </button>
                  ) : (
                    <span className={GONE_CHIP}>A book no longer in your library</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {rec.status === 'served' ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={onAccept}>
              Want to watch
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={onWatched}>
              Already watched
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onReject}>
              Not for me
            </Button>
          </div>
        ) : (
          <p className="text-sm font-medium text-accent">{OUTCOME[rec.status]}</p>
        )}
      </div>
    </article>
  );
}
