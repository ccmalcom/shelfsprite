'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Trait } from '@/lib/api';
import { Button, Card } from '@/components/ui';
import ShelfSprite from '@/components/ShelfSprite';
import { TraitRow, type TitleEvidence } from './TraitRow';

type Filter = 'all' | 'reward' | 'aversion';

export interface TraitsSectionProps {
  traits: Trait[];
  bookMap: Map<number, string>;
  onBuildProfile: () => Promise<void>;
  /** Wave 8 supplies this; TraitRow renders it. */
  titleEvidence?: Map<number, TitleEvidence>;
}

// ─── Build profile CTA (moved verbatim from app/(main)/profile/page.tsx) ──────

function BuildProfileCTA({ onBuild }: { onBuild: () => Promise<void> }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handle() {
    setRunning(true);
    setError(null);
    try {
      await onBuild();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The profile build failed. Your books are untouched; try again.'
      );
      setRunning(false);
    }
  }

  return (
    <Card className="text-center space-y-4">
      <ShelfSprite
        variant="analyze"
        sizes="128px"
        className={['mx-auto h-32 w-32', running ? 'motion-safe:animate-pulse' : ''].join(' ')}
      />
      <p className="text-muted font-medium">No taste profile yet.</p>
      <p className="text-sm text-faint">
        Claude will read your rated books and infer what you love and avoid. This takes about 30
        seconds and needs your Anthropic API key.
      </p>
      <Button loading={running} onClick={handle}>
        {running ? 'Building profile\u2026' : 'Build profile'}
      </Button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  );
}

// ─── ?trait= watcher ──────────────────────────────────────────────────────────

/**
 * Reads ?trait=<id> and asks the section to focus that trait once per parameter value.
 *
 * Lives in its own component because useSearchParams must sit under a <Suspense> boundary
 * or `next build` fails on the prerendered /profile page. It holds no useState: the focus
 * work is done by the parent's callback, so react-hooks/set-state-in-effect has nothing to
 * flag here. The applied-value ref is written only inside the effect (react-hooks/refs).
 */
function TraitParamWatcher({
  traitIds,
  onFocus,
}: {
  traitIds: number[];
  onFocus: (id: number) => void;
}) {
  const param = useSearchParams().get('trait');
  const applied = useRef<string | null>(null);

  useEffect(() => {
    if (param === null) {
      applied.current = null;
      return;
    }
    if (applied.current === param) return;
    if (!/^\d+$/.test(param)) return;
    const id = Number(param);
    if (!traitIds.includes(id)) return;
    applied.current = param;
    onFocus(id);
  }, [param, traitIds, onFocus]);

  return null;
}

// ─── Section ──────────────────────────────────────────────────────────────────

export function TraitsSection({
  traits,
  bookMap,
  onBuildProfile,
  titleEvidence,
}: TraitsSectionProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [openIds, setOpenIds] = useState<Set<number>>(() => new Set());
  // A fresh object per focus request, so focusing the same id twice still scrolls twice.
  const [scrollRequest, setScrollRequest] = useState<{ id: number } | null>(null);

  const rewards = traits.filter((t) => t.polarity === 'reward');
  const aversions = traits.filter((t) => t.polarity === 'aversion');
  const visible = filter === 'all' ? traits : filter === 'reward' ? rewards : aversions;
  // Stable between renders that do not change `traits`: the watcher's effect depends on it, and
  // an unstable dep would make the once-per-value ref the only thing preventing a render loop.
  const traitIds = useMemo(() => traits.map((t) => t.id), [traits]);

  useEffect(() => {
    if (scrollRequest === null) return;
    document
      .getElementById(`trait-${scrollRequest.id}`)
      ?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [scrollRequest]);

  function toggle(id: number) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // useCallback for the same reason as traitIds: it is a dep of the watcher's effect.
  const focusTrait = useCallback(
    (id: number) => {
      const target = traits.find((t) => t.id === id);
      if (!target) return;
      if (filter !== 'all' && target.polarity !== filter) setFilter('all');
      setOpenIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setScrollRequest({ id });
    },
    [traits, filter]
  );

  const filterBtnClass = (active: boolean) =>
    [
      'rounded-md px-2.5 py-1 text-xs capitalize transition',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
      active ? 'bg-elevated text-text' : 'text-muted hover:text-text',
    ].join(' ');

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">Taste traits</h2>
          <p className="mt-0.5 text-xs text-faint">
            Claude inferred these from your ratings. Open a trait to confirm, reject, or reword it.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-elevated p-1">
          {(['all', 'reward', 'aversion'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={filterBtnClass(filter === f)}
            >
              {f === 'all'
                ? `All (${traits.length})`
                : f === 'reward'
                  ? `Loves (${rewards.length})`
                  : `Avoids (${aversions.length})`}
            </button>
          ))}
        </div>
      </div>

      {traits.length > 0 && (
        <Suspense fallback={null}>
          <TraitParamWatcher traitIds={traitIds} onFocus={focusTrait} />
        </Suspense>
      )}

      {traits.length === 0 ? (
        <BuildProfileCTA onBuild={onBuildProfile} />
      ) : visible.length === 0 ? (
        <p className="py-10 text-center text-faint">Nothing under this filter.</p>
      ) : (
        <div className="space-y-3">
          {visible.map((t) => (
            <TraitRow
              key={t.id}
              trait={t}
              bookMap={bookMap}
              open={openIds.has(t.id)}
              onToggle={() => toggle(t.id)}
              titleEvidence={titleEvidence}
            />
          ))}
        </div>
      )}
    </section>
  );
}
