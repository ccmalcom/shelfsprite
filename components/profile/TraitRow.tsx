'use client';

import { useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import { ChevronDown, Film, Tv } from 'lucide-react';
import { api, setTraitVerdict, type Trait, PROFILE_STATUS_KEY, TRAITS_KEY } from '@/lib/api';
import { Badge, Button, useToast } from '@/components/ui';

/** A film or show a trait cites (spec §7.5, §8). */
export interface TitleEvidence {
  id: number;
  title: string;
  year: number | null;
  media_type: 'movie' | 'tv';
}

export interface TraitRowProps {
  trait: Trait;
  bookMap: Map<number, string>;
  /** Controlled by TraitsSection so the ?trait= deep link can open a row. */
  open: boolean;
  onToggle: () => void;
  /** Films and shows this trait cites, passed only while ScreenSprite is on (spec §7.5). */
  titleEvidence?: Map<number, TitleEvidence>;
}

type BadgeVariant = 'default' | 'success' | 'danger' | 'accent';

function statusVariant(status: string): BadgeVariant {
  if (status === 'edited') return 'accent';
  if (status === 'confirmed') return 'success';
  if (status === 'rejected') return 'danger';
  return 'default';
}

function TitleBadge({
  title,
  variant = 'default',
}: {
  title: TitleEvidence;
  variant?: 'default' | 'mono';
}) {
  const Icon = title.media_type === 'tv' ? Tv : Film;
  return (
    <Badge variant={variant} className="inline-flex items-center gap-1">
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">{title.media_type === 'tv' ? 'TV:' : 'Film:'}</span>
      <span>{title.year === null ? title.title : `${title.title} (${title.year})`}</span>
    </Badge>
  );
}

export function TraitRow({ trait, bookMap, open, onToggle, titleEvidence }: TraitRowProps) {
  const toast = useToast();
  const isReward = trait.polarity === 'reward';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trait.claim);
  const [saving, setSaving] = useState(false);
  const [verdicting, setVerdicting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
      textareaRef.current.focus();
    }
  }, [editing, draft]);

  function startReword() {
    setDraft(trait.claim);
    setEditing(true);
  }

  async function save() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === trait.claim) {
      setEditing(false);
      setDraft(trait.claim);
      return;
    }
    setSaving(true);
    try {
      await api.updateTrait(trait.id, { claim: trimmed });
      await mutate(TRAITS_KEY);
      toast.success('Noted. Your profile just got sharper.');
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setEditing(false);
    setDraft(trait.claim);
  }

  async function handleVerdict(status?: 'confirmed' | 'rejected', user_weight?: number) {
    setVerdicting(true);
    try {
      const updated = await setTraitVerdict(trait.id, { status, user_weight });
      await mutate(
        TRAITS_KEY,
        (prev: Trait[] | undefined) => (prev ?? []).map((t) => (t.id === updated.id ? updated : t)),
        { revalidate: false }
      );
      await mutate(PROFILE_STATUS_KEY);
      toast.success("Updated. We'll recommend accordingly.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed.');
    } finally {
      setVerdicting(false);
    }
  }

  function handleHeaderClick() {
    // Collapsing mid-edit would hide (and on a filter change, discard) a half-typed draft.
    if (editing) return;
    onToggle();
  }

  const exhibitTitles = (trait.exhibits ?? [])
    .map((id) => bookMap.get(id))
    .filter(Boolean) as string[];
  const contrastTitles = (trait.contrasts ?? [])
    .map((id) => bookMap.get(id))
    .filter(Boolean) as string[];
  // Books first, so a book-only trait renders exactly as before; titles fill the same caps.
  const exhibitRefs = (trait.exhibit_title_ids ?? [])
    .map((id) => titleEvidence?.get(id))
    .filter((t): t is TitleEvidence => t !== undefined)
    .slice(0, Math.max(0, 4 - exhibitTitles.length));
  const contrastRefs = (trait.contrast_title_ids ?? [])
    .map((id) => titleEvidence?.get(id))
    .filter((t): t is TitleEvidence => t !== undefined)
    .slice(0, Math.max(0, 3 - contrastTitles.length));
  const hasExhibits = exhibitTitles.length > 0 || exhibitRefs.length > 0;
  const hasContrasts = contrastTitles.length > 0 || contrastRefs.length > 0;

  const polarityVariant = isReward ? 'success' : 'danger';
  const polarityLabel = isReward ? 'Loves' : 'Avoids';
  const borderClass = isReward ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5';

  const isRejected = trait.status === 'rejected';
  const isConfirmed = trait.status === 'confirmed';
  const hasLowWeight = trait.user_weight != null && trait.user_weight < 1.0;
  const panelId = `trait-panel-${trait.id}`;

  return (
    <div
      id={`trait-${trait.id}`}
      className={[
        'scroll-mt-6 rounded-xl border transition',
        borderClass,
        isRejected ? 'opacity-50' : '',
      ].join(' ')}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-disabled={editing ? true : undefined}
        onClick={handleHeaderClick}
        className={[
          'flex w-full items-start gap-3 rounded-xl p-4 text-left',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        ].join(' ')}
      >
        <Badge variant={polarityVariant} className="mt-0.5 shrink-0">
          {polarityLabel}
        </Badge>
        <span
          className={[
            'min-w-0 flex-1 text-sm',
            open ? '' : 'line-clamp-2',
            isRejected ? 'line-through text-faint' : 'text-text',
          ].join(' ')}
        >
          {trait.claim}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-mono text-xs text-faint">
            {Math.round(trait.inference_confidence * 100)}%
          </span>
          {trait.status !== 'proposed' && (
            <Badge variant={statusVariant(trait.status)}>{trait.status}</Badge>
          )}
          {hasLowWeight && trait.user_weight != null && (
            <span className="font-mono text-xs text-faint" title="Reduced weight">
              {`${Math.round(trait.user_weight * 10) / 10}x`}
            </span>
          )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={[
            'mt-0.5 h-4 w-4 shrink-0 text-faint transition-transform',
            open ? 'rotate-180' : '',
          ].join(' ')}
        />
      </button>

      <div id={panelId} hidden={!open} className="space-y-3 px-4 pb-4 pl-14">
        {editing ? (
          <>
            <textarea
              aria-label="Edit trait claim"
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={1}
              className={[
                'w-full resize-none rounded-lg border border-accent bg-elevated px-3 py-2',
                'text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              ].join(' ')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
                if (e.key === 'Escape') cancel();
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" loading={saving} onClick={() => void save()}>
                {saving ? 'Saving\u2026' : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <span className="text-xs text-faint">Cmd+Enter to save · Esc to cancel</span>
            </div>
          </>
        ) : (
          <>
            {(hasExhibits || hasContrasts) && (
              <div className="space-y-1.5">
                {hasExhibits && (
                  <div className="flex flex-wrap gap-1">
                    <span className="mr-1 text-xs text-faint">e.g.</span>
                    {exhibitTitles.slice(0, 4).map((t) => (
                      <Badge key={t} variant="mono">
                        {t}
                      </Badge>
                    ))}
                    {exhibitRefs.map((t) => (
                      <TitleBadge key={`title-${t.id}`} title={t} variant="mono" />
                    ))}
                  </div>
                )}
                {hasContrasts && (
                  <div className="flex flex-wrap gap-1">
                    <span className="mr-1 text-xs text-faint">unlike</span>
                    {contrastTitles.slice(0, 3).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                    {contrastRefs.map((t) => (
                      <TitleBadge key={`title-${t.id}`} title={t} />
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={isConfirmed ? 'primary' : 'ghost'}
                disabled={verdicting}
                onClick={() => void handleVerdict('confirmed')}
                title="That's me"
              >
                Confirm
              </Button>
              <Button
                size="sm"
                variant={isRejected ? 'danger' : 'ghost'}
                disabled={verdicting}
                onClick={() => void handleVerdict('rejected')}
                title="Not me"
              >
                Not me
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={verdicting}
                onClick={() => void handleVerdict(undefined, 0.5)}
                title="Turn this down"
              >
                Apply less
              </Button>
              <Button size="sm" variant="ghost" onClick={startReword}>
                Reword
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
