'use client';

import { useState } from 'react';
import { setTraitVerdict, api, type Trait } from '@/lib/api';
import { useToast } from '@/components/ui';
import { readerLine, type Beat, type ContrastRelation } from '@/lib/revealBeats';
import { RevealButton } from './revealFrame';

type RewardBeat = Extract<Beat, { kind: 'reward-trait' }>;
type AversionsBeat = Extract<Beat, { kind: 'aversions' }>;

export type Verdict = 'confirmed' | 'edited' | 'rejected';

const CONFIRM_TOAST = "Noted. We'll lean on this.";
const REJECT_TOAST = 'Fair enough, forgotten.';

/** "A", "A and B", or "A, B, and C" — matches the spec's evidence-row grammar. */
function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const PRIMARY_BUTTON = 'rounded-lg bg-user px-4 py-2 text-sm font-semibold text-base';
const NEUTRAL_BUTTON =
  'rounded-lg border border-border px-4 py-2 text-sm text-muted hover:text-text';

/** The parenthetical under a reward beat, worded by how the contrast book was actually rated. */
function contrastLine(title: string, relation: ContrastRelation): string {
  const quoted = `\u201C${title}\u201D`;
  if (relation === 'lower') return `(Rated lower: ${quoted}.)`;
  if (relation === 'higher') return `(Rated higher: ${quoted}.)`;
  return `(For contrast: ${quoted}.)`;
}

/** Shared verdict-control cluster for one trait. */
function VerdictControls({
  trait,
  lowConfidence,
  labels,
  emphasizeConfirm = true,
  onVerdict,
  onNext,
}: {
  trait: Trait;
  lowConfidence: boolean;
  labels: { confirm: string; reject: string; edit: string };
  /** False where several traits sit side by side, so no answer looks chosen in advance. */
  emphasizeConfirm?: boolean;
  onVerdict: (id: number, v: Verdict) => void;
  onNext: () => void;
}) {
  const toast = useToast();
  // The editor starts from the sentence the reader just read, not the model's analytic claim.
  const shownText = readerLine(trait);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(shownText);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<Verdict | null>(null);

  const buttonClass = (verdict: Verdict, base: string) =>
    chosen === null
      ? `${base} disabled:opacity-50`
      : chosen === verdict
        ? PRIMARY_BUTTON
        : `${NEUTRAL_BUTTON} opacity-50`;

  async function confirm() {
    setBusy(true);
    try {
      await setTraitVerdict(trait.id, { status: 'confirmed' });
      onVerdict(trait.id, 'confirmed');
      setChosen('confirmed');
      toast.success(CONFIRM_TOAST);
      onNext();
    } catch {
      toast.error("That didn't take. Try again.");
      setBusy(false);
    }
  }

  async function reject() {
    setBusy(true);
    try {
      await setTraitVerdict(trait.id, { status: 'rejected' });
      onVerdict(trait.id, 'rejected');
      setChosen('rejected');
      toast.info(REJECT_TOAST);
      onNext();
    } catch {
      toast.error("That didn't take. Try again.");
      setBusy(false);
    }
  }

  async function saveEdit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.updateTrait(trait.id, { claim: trimmed, user_note: trimmed });
      onVerdict(trait.id, 'edited');
      setChosen('edited');
      setEditing(false);
      toast.success('Noted. Your profile just got sharper.');
      onNext();
    } catch {
      toast.error("That didn't take. Try again.");
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <textarea
          aria-label="Rewrite this trait in your own words"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          autoFocus
          className="w-full resize-none rounded-lg border border-user bg-elevated px-3 py-2 text-sm text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        />
        <p className="text-xs text-faint">
          Say it your way. It feeds your recommendations directly.
        </p>
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveEdit()}
            className="rounded-lg bg-user px-4 py-2 text-sm font-semibold text-base disabled:opacity-50"
          >
            That’s better
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="px-3 py-2 text-sm text-muted hover:text-text"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <button
        type="button"
        disabled={busy}
        aria-pressed={chosen === null ? undefined : chosen === 'confirmed'}
        onClick={() => void confirm()}
        className={buttonClass('confirmed', emphasizeConfirm ? PRIMARY_BUTTON : NEUTRAL_BUTTON)}
      >
        {lowConfidence ? 'Actually, yes' : labels.confirm}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-pressed={chosen === null ? undefined : chosen === 'rejected'}
        onClick={() => void reject()}
        className={buttonClass('rejected', NEUTRAL_BUTTON)}
      >
        {labels.reject}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-pressed={chosen === null ? undefined : chosen === 'edited'}
        onClick={() => {
          setDraft(shownText);
          setEditing(true);
        }}
        className={buttonClass('edited', 'px-3 py-2 text-sm text-faint hover:text-muted')}
      >
        {labels.edit}
      </button>
    </div>
  );
}

export function RewardTraitBeat({
  beat,
  onNext,
  onVerdict,
}: {
  beat: RewardBeat;
  onNext: () => void;
  onVerdict: (id: number, v: Verdict) => void;
}) {
  const { trait, lowConfidence, exhibitTitles, contrastTitles, contrastRelation } = beat;
  const line = readerLine(trait);
  const evidence =
    exhibitTitles.length > 0
      ? `Because of ${joinWithAnd(exhibitTitles.map((t) => `\u201C${t}\u201D`))}.`
      : null;

  return (
    <div className="space-y-5">
      {lowConfidence && (
        <p className="font-mono text-xs italic text-faint">We’re less sure about this one.</p>
      )}
      <h2 className="font-display text-3xl font-bold leading-tight text-text sm:text-4xl">
        <span className="text-user">{line}</span>
      </h2>
      {evidence && <p className="text-sm text-muted">{evidence}</p>}
      {contrastTitles.length > 0 && (
        <p className="text-xs italic text-faint">
          {contrastLine(contrastTitles[0], contrastRelation)}
        </p>
      )}
      <div className="pt-2">
        <VerdictControls
          trait={trait}
          lowConfidence={lowConfidence}
          labels={{ confirm: 'That\u2019s me', reject: 'Not me', edit: 'Almost\u2026' }}
          onVerdict={onVerdict}
          onNext={onNext}
        />
      </div>
    </div>
  );
}

export function AversionsBeat({
  beat,
  onNext,
  onVerdict,
}: {
  beat: AversionsBeat;
  onNext: () => void;
  onVerdict: (id: number, v: Verdict) => void;
}) {
  return (
    <div className="space-y-5">
      <h2 className="font-display text-2xl font-bold leading-tight text-text sm:text-3xl">
        And some things you’ve quietly told us you’re done with.
      </h2>
      <ul className="space-y-4 text-left">
        {beat.items.map(({ trait, evidence }) => (
          <li key={trait.id} className="border-l-2 border-danger/40 pl-3">
            <p className="text-sm text-text">{readerLine(trait)}</p>
            {evidence && <p className="mb-2 text-xs italic text-faint">{evidence}</p>}
            <VerdictControls
              trait={trait}
              lowConfidence={false}
              emphasizeConfirm={false}
              labels={{
                confirm: 'True',
                reject: 'Not me',
                edit: 'It\u2019s more specific than that\u2026',
              }}
              onVerdict={onVerdict}
              onNext={() => {
                /* aversions advance together; per-line verdict does not auto-advance */
              }}
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-faint">
        Aversions matter as much as favorites. They’re half of what makes recommendations feel like
        yours.
      </p>
      <RevealButton onClick={onNext}>Continue</RevealButton>
    </div>
  );
}
