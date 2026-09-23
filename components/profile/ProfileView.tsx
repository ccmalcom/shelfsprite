'use client';

import PageHeading from '@/components/PageHeading';

import { useState, useRef, useEffect, useMemo } from 'react';
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
  BOOKS_ALL_KEY,
  screenApi,
  SCREEN_TITLES_KEY,
  type TitleOut,
} from '@/lib/api';
import { useScreenSettings } from '@/lib/useScreenSettings';
import { titleEvidenceMap } from '@/lib/screen';
import { TasteHero } from '@/components/TasteHero';
import CustomInstructions from '@/components/CustomInstructions';
import RevealSequence from '@/components/reveal/RevealSequence';
import { useFeedbackPrompt } from '@/hooks/useFeedbackPrompt';
import { TraitsSection } from '@/components/profile/TraitsSection';
import { GenreSection, RatingSection } from '@/components/profile/StatSections';
import { ScreenStats } from '@/components/profile/ScreenStats';

const STATS_KEY = 'stats';
const SUBJECTS_KEY = 'profile-subjects';

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

/**
 * The one unified taste profile, rendered in both sections. Only the closing stats differ:
 * /profile shows book stats, /screen/profile shows film and TV stats.
 */
export function ProfileView({ section = 'books' }: { section?: 'books' | 'screen' }) {
  const isScreen = section === 'screen';
  const { data: traits = [], isLoading: traitsLoading } = useSWR<Trait[]>(TRAITS_KEY, () =>
    api.profile()
  );
  const { data: stats, isLoading: statsLoading } = useSWR<Stats>(isScreen ? null : STATS_KEY, () =>
    api.stats()
  );
  const { data: subjects, isLoading: subjectsLoading } = useSWR<SubjectBreakdown>(
    isScreen ? null : SUBJECTS_KEY,
    () => api.profileSubjects()
  );
  const { data: allBooks = [] } = useSWR<Book[]>(BOOKS_ALL_KEY, () => api.books({ limit: 500 }));
  const { enabled: screenEnabled } = useScreenSettings();
  const {
    data: titles,
    error: titlesError,
    isLoading: titlesLoading,
    mutate: retryTitles,
  } = useSWR<TitleOut[]>(screenEnabled ? SCREEN_TITLES_KEY : null, () => screenApi.titles());
  // Films and shows as evidence only while ScreenSprite is on (spec §7.5). undefined keeps
  // TraitRow and the reveal exactly as they are for a books-only reader.
  const titleEvidence = useMemo(
    () => (screenEnabled && titles ? titleEvidenceMap(titles) : undefined),
    [screenEnabled, titles]
  );
  const { data: me } = useSWR(ADMIN_ME_KEY, adminMe);

  const bookMap = new Map(allBooks.map((b) => [b.id, b.title]));
  const isLoading = traitsLoading || (isScreen ? titlesLoading : statsLoading || subjectsLoading);
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
        description={
          screenEnabled
            ? 'What your books, films and shows have in common, and what makes a story work for you. Keep the parts that ring true. Correct the rest.'
            : 'What your books have in common, and what makes a story work for you. Keep the parts that ring true. Correct the rest.'
        }
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
        <TasteHero compact bookSubjects={!isScreen} />
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
          <TraitsSection
            traits={traits}
            bookMap={bookMap}
            titleEvidence={titleEvidence}
            onBuildProfile={handleBuildProfile}
          />
          <CustomInstructions />
          {isScreen ? (
            titles ? (
              <ScreenStats titles={titles} />
            ) : (
              titlesError && (
                // SWR keeps the last good titles through a failed refresh, so this shows only with none.
                <p role="alert" className="py-10 text-center text-faint">
                  Your films and shows didn&apos;t load.{' '}
                  <button
                    type="button"
                    onClick={() => void retryTitles()}
                    className="underline underline-offset-4 hover:text-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent rounded"
                  >
                    Try again
                  </button>
                </p>
              )
            )
          ) : (
            <>
              {stats && (
                <RatingSection
                  byStar={stats.by_star ?? {}}
                  rated={stats.rated ?? 0}
                  meanRating={stats.mean_rating}
                  noun="book"
                />
              )}
              {subjects && (
                <GenreSection
                  subjects={subjects}
                  description="Subjects from enriched catalog data across your rated books."
                  emptyText="No subject data yet. Run enrich to pull catalog metadata."
                />
              )}
            </>
          )}
        </>
      )}
      {profileModal}
    </div>
  );
}
