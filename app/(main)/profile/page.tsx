'use client';

import PageHeading from '@/components/PageHeading';

import { useState, useRef, useEffect } from 'react';
import useSWR, { mutate } from 'swr';
import Link from 'next/link';
import { Settings, Shield } from 'lucide-react';
import {
  api,
  type Trait,
  type Stats,
  type SubjectBreakdown,
  type Book,
  adminMe,
  ADMIN_ME_KEY,
  PROFILE_STATUS_KEY,
  TRAITS_KEY,
} from '@/lib/api';
import { Card } from '@/components/ui';
import { TasteHero } from '@/components/TasteHero';
import CustomInstructions from '@/components/CustomInstructions';
import RevealSequence from '@/components/reveal/RevealSequence';
import { useFeedbackPrompt } from '@/hooks/useFeedbackPrompt';
import { TraitsSection } from '@/components/profile/TraitsSection';

const STATS_KEY = 'stats';
const SUBJECTS_KEY = 'profile-subjects';
const BOOKS_KEY = 'books-all';

// ─── Rating distribution ──────────────────────────────────────────────────────

function RatingSection({ stats }: { stats: Stats }) {
  const total = stats.rated ?? 0;
  const byStarData = stats.by_star ?? {};
  const buckets = Array.from(
    new Set([
      5,
      4,
      3,
      2,
      1,
      ...Object.keys(byStarData)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0),
    ])
  ).sort((a, b) => b - a);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-lg font-semibold text-text">Rating distribution</h2>
        <p className="mt-0.5 text-xs text-faint">
          {total} rated book{total !== 1 ? 's' : ''}{' '}
          {stats.mean_rating != null ? `· mean ${stats.mean_rating.toFixed(2)}` : ''}
        </p>
      </div>
      <Card>
        <div className="space-y-3">
          {buckets.map((star) => {
            const count = byStarData[String(star)] ?? 0;
            const pct = total > 0 ? (count / total) * 100 : 0;
            return (
              <div key={star} className="flex items-center gap-3">
                <span className="w-14 shrink-0 text-right font-mono text-sm text-accent">
                  {'\u2605'.repeat(Math.floor(star))}
                  {star % 1 ? '\u00bd' : ''}
                </span>
                <div className="flex-1 overflow-hidden rounded-full bg-elevated h-2.5">
                  <div
                    className="h-2.5 rounded-full bg-accent transition-all duration-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right font-mono text-sm text-muted">
                  {count} <span className="text-faint text-xs">({pct.toFixed(0)}%)</span>
                </span>
              </div>
            );
          })}
        </div>
      </Card>
    </section>
  );
}

// ─── Genre breakdown ──────────────────────────────────────────────────────────

function GenreSection({ subjects }: { subjects: SubjectBreakdown }) {
  const [tier, setTier] = useState<string>('all');
  // Re-sort client-side: `by_tier` is a plain object, so V8 emits the
  // integer-like keys ("3", "4", "5") ascending ahead of the half-star string
  // keys ("3.5", "4.5"), discarding the route's descending sort.
  const tierKeys = Object.keys(subjects.by_tier).sort((a, b) => Number(b) - Number(a));

  const items = tier === 'all' ? subjects.overall : (subjects.by_tier[tier] ?? []);
  const maxCount = items[0]?.count ?? 1;

  const filterBtnClass = (active: boolean) =>
    [
      'rounded-md px-2.5 py-1 text-xs transition',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      active ? 'bg-elevated text-text' : 'text-muted hover:text-text',
    ].join(' ');

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">Genre breakdown</h2>
          <p className="mt-0.5 text-xs text-faint">
            Subjects from enriched catalog data across your rated books.
          </p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-elevated p-1">
          <button onClick={() => setTier('all')} className={filterBtnClass(tier === 'all')}>
            All
          </button>
          {tierKeys.map((k) => (
            <button
              key={k}
              onClick={() => setTier(k)}
              className={filterBtnClass(tier === k)}
              aria-label={`${k} star${k === '1' ? '' : 's'}`}
            >
              {'\u2605'.repeat(Math.floor(Number(k)))}
              {Number(k) % 1 ? '\u00bd' : ''}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="py-10 text-center text-faint">
          No subject data yet. Run enrich to pull catalog metadata.
        </p>
      ) : (
        <Card>
          <div className="space-y-2.5">
            {items.map(({ subject, count }) => {
              const pct = (count / maxCount) * 100;
              return (
                <div key={subject} className="flex items-center gap-3">
                  <span
                    className="w-24 sm:w-40 shrink-0 truncate text-sm text-muted"
                    title={subject}
                  >
                    {subject}
                  </span>
                  <div className="flex-1 overflow-hidden rounded-full bg-elevated h-2">
                    <div
                      className="h-2 rounded-full bg-accent transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-6 shrink-0 text-right font-mono text-xs text-faint">
                    {count}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </section>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="h-16 rounded-xl border border-border bg-surface motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const { data: traits = [], isLoading: traitsLoading } = useSWR<Trait[]>(TRAITS_KEY, () =>
    api.profile()
  );
  const { data: stats, isLoading: statsLoading } = useSWR<Stats>(STATS_KEY, () => api.stats());
  const { data: subjects, isLoading: subjectsLoading } = useSWR<SubjectBreakdown>(
    SUBJECTS_KEY,
    () => api.profileSubjects()
  );
  const { data: allBooks = [] } = useSWR<Book[]>(BOOKS_KEY, () => api.books({ limit: 500 }));
  const { data: me } = useSWR(ADMIN_ME_KEY, adminMe);

  const bookMap = new Map(allBooks.map((b) => [b.id, b.title]));
  const isLoading = traitsLoading || statsLoading || subjectsLoading;
  const [revealOpen, setRevealOpen] = useState(false);

  // post-first-profile feedback prompt: fire once when profile data first loads
  const { fire: fireProfilePrompt, modal: profileModal } = useFeedbackPrompt('post-first-profile');
  const profileFiredRef = useRef(false);
  useEffect(() => {
    if (!traitsLoading && !profileFiredRef.current) {
      profileFiredRef.current = true;
      fireProfilePrompt();
    }
  }, [traitsLoading, fireProfilePrompt]);

  async function handleBuildProfile() {
    await api.runProfile();
    await Promise.all([mutate(TRAITS_KEY), mutate(PROFILE_STATUS_KEY)]);
  }

  return (
    <div className="editorial-page fade-in space-y-8">
      <PageHeading
        eyebrow="The reader behind the ratings"
        title="Your taste profile"
        description="What your books have in common, and what makes a story work for you. Keep the parts that ring true. Correct the rest."
      />
      <div className="space-y-3">
        {/* Mobile escape hatch for the routes the 5-tab bottom nav has no room for
            (lib/nav.ts). /admin is not in NAV_ROUTES at all — it is conditional on
            is_admin — so without this link an admin on a phone can only reach it by
            typing the URL. */}
        <div className="flex justify-end gap-1 sm:hidden">
          {me?.is_admin && (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs text-faint transition-colors hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <Shield size={14} aria-hidden="true" />
              Admin
            </Link>
          )}
          <Link
            href="/settings"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs text-faint transition-colors hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <Settings size={14} aria-hidden="true" />
            Settings
          </Link>
        </div>
        <TasteHero compact />
        {traits.length > 0 && (
          <div className="text-center">
            <button
              type="button"
              onClick={() => setRevealOpen(true)}
              className="font-mono text-xs text-faint hover:text-muted transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
            >
              Replay my reveal
            </button>
          </div>
        )}
      </div>

      {revealOpen && (
        <RevealSequence
          onClose={() => setRevealOpen(false)}
          onFinish={() => setRevealOpen(false)}
        />
      )}

      {isLoading ? (
        <Skeleton />
      ) : (
        <>
          <TraitsSection traits={traits} bookMap={bookMap} onBuildProfile={handleBuildProfile} />
          <CustomInstructions />
          {stats && <RatingSection stats={stats} />}
          {subjects && <GenreSection subjects={subjects} />}
        </>
      )}
      {profileModal}
    </div>
  );
}
