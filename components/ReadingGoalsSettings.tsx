'use client';

import { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { api, GOALS_KEY, type Goal, type GoalKind, type GoalsResponse } from '@/lib/api';
import { Button, Card, Input, useToast } from '@/components/ui';

const KIND_OPTIONS: { value: GoalKind; label: string }[] = [
  { value: 'books', label: 'Books read' },
  { value: 'genre', label: 'Books in a genre' },
  { value: 'new_authors', label: 'New-to-you authors' },
  { value: 'pages', label: 'Pages read' },
];

// Copied from components/admin/UsageTab.tsx:50 -- the established raw-<select> pattern,
// since components/ui has no Select.
const SELECT_CLASS =
  'rounded-lg border border-border bg-base px-2 py-1 text-xs text-text focus:border-accent focus:outline-none';

function goalLabel(g: Goal): string {
  if (g.kind === 'genre') return g.subject ?? 'Genre';
  return KIND_OPTIONS.find((k) => k.value === g.kind)?.label ?? g.kind;
}

export default function ReadingGoalsSettings() {
  const toast = useToast();
  const { data } = useSWR<GoalsResponse>(GOALS_KEY, () => api.listGoals());

  const [kind, setKind] = useState<GoalKind>('books');
  const [subject, setSubject] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const year = data?.year;

  // The API owns the user-facing message (e.g. 409 -> "That goal already exists for
  // this year."), so pass it straight through the same way the rest of the settings
  // page's forms do rather than inventing our own copy.
  function fail(e: unknown, fallback: string) {
    toast.error(e instanceof Error ? e.message : fallback);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(target);
    if (!Number.isInteger(n) || n <= 0) {
      toast.error('Target must be a positive whole number.');
      return;
    }
    if (kind === 'genre' && !subject.trim()) {
      toast.error('A genre goal needs a genre.');
      return;
    }
    setBusy(true);
    try {
      await api.createGoal({
        kind,
        target: n,
        ...(kind === 'genre' ? { subject: subject.trim() } : {}),
      });
      await mutate(GOALS_KEY);
      setSubject('');
      setTarget('');
      toast.success('Goal added.');
    } catch (err) {
      fail(err, 'Could not add that goal.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTarget(goal: Goal, raw: string) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || n === goal.target) return;
    try {
      await api.updateGoal(goal.id, n);
      await mutate(GOALS_KEY);
    } catch (err) {
      fail(err, 'Could not update that goal.');
    }
  }

  async function handleDelete(goal: Goal) {
    try {
      await api.deleteGoal(goal.id);
      await mutate(GOALS_KEY);
      toast.success('Goal removed.');
    } catch (err) {
      fail(err, 'Could not remove that goal.');
    }
  }

  return (
    <Card>
      <h2 className="mb-1 font-display text-lg font-semibold text-text">Reading goals</h2>
      <p className="mb-4 text-sm text-muted">
        Goals track books you have marked read with a date in {year ?? 'this year'}.
      </p>

      {data && data.goals.length > 0 && (
        <ul className="mb-6 space-y-2">
          {data.goals.map((g) => (
            <li key={g.id} className="flex items-center gap-3">
              <span className="flex-1 truncate text-sm text-text">{goalLabel(g)}</span>
              <span className="font-mono text-xs text-faint">{g.progress} /</span>
              <Input
                key={`${g.id}-${g.target}`}
                type="number"
                min={1}
                defaultValue={g.target}
                aria-label={`Target for ${goalLabel(g)}`}
                className="w-20"
                onBlur={(e) => handleTarget(g, e.target.value)}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => handleDelete(g)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-3">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as GoalKind)}
          aria-label="Goal type"
          className={SELECT_CLASS}
        >
          {KIND_OPTIONS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>

        {kind === 'genre' && (
          <>
            <Input
              list="goal-subject-suggestions"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="History"
              aria-label="Genre"
              className="w-44"
            />
            <datalist id="goal-subject-suggestions">
              {(data?.subjects ?? []).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </>
        )}

        <Input
          type="number"
          min={1}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="10"
          aria-label="Target"
          className="w-24"
        />

        <Button type="submit" loading={busy} disabled={busy}>
          Add goal
        </Button>
      </form>
    </Card>
  );
}
