'use client';

import { useEffect, useRef, useState } from 'react';
import type { Book, BookMatchResult } from '@/lib/api';
import {
  authorEchoes,
  parsePastedList,
  PASTE_MAX_ITEMS,
  type PastedTitle,
} from '@/lib/server/pasteList';
import { matchInBatches } from '@/lib/matchBatches';
import { Button, Field, Textarea } from '@/components/ui';
import BulkReview, { type ReviewRow, type UnmatchedLine } from '@/components/onboarding/BulkReview';

type Stage =
  | { kind: 'input' }
  | { kind: 'matching'; done: number; total: number }
  | {
      kind: 'review';
      rows: ReviewRow[];
      unmatched: UnmatchedLine[];
      note: string | undefined;
    };

/** Splits matched lines into review rows and unmatched lines, dropping Kindle author echoes. */
export function reviewFromMatches(
  items: PastedTitle[],
  results: BookMatchResult[]
): { rows: ReviewRow[]; unmatched: UnmatchedLine[]; echoes: number } {
  const unmatchedIdx = new Set(results.filter((r) => r.status !== 'matched').map((r) => r.index));
  const matchedAuthors = results.map((r) => (r.status === 'matched' ? r.best.author : null));
  const echoes = authorEchoes(items, matchedAuthors, unmatchedIdx);
  const rows: ReviewRow[] = [];
  const unmatched: UnmatchedLine[] = [];
  for (const r of results) {
    const item = items[r.index];
    if (!item) continue;
    const key = `line-${item.line}`;
    if (r.status === 'matched') {
      rows.push({
        key,
        source: item.raw,
        book: r.best,
        alternatives: r.alternatives,
        rating: 0,
      });
    } else if (!echoes.has(r.index)) {
      unmatched.push({ key, text: item.author ? `${item.title} by ${item.author}` : item.title });
    }
  }
  return { rows, unmatched, echoes: echoes.size };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Paste a list of titles from anywhere, match each line against the catalog, then review.
 * Lines are parsed in the browser (lib/server/pasteList.ts) so the count shows as you paste;
 * matching runs in small batches through POST /books/match.
 */
export default function PasteImport({
  onAdded,
  onCancel,
  baselineRatings,
  cancelLabel = 'Cancel',
}: {
  onAdded: (books: Book[]) => void;
  onCancel: () => void;
  baselineRatings?: ReadonlyArray<number | null | undefined>;
  cancelLabel?: string;
}) {
  const [text, setText] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'input' });
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const parsed = parsePastedList(text);
  const count = parsed.items.length;

  async function handleMatch() {
    const items = parsed.items;
    if (items.length === 0) return;
    setStage({ kind: 'matching', done: 0, total: items.length });
    const results = await matchInBatches(items, 'best', {
      isCancelled: () => cancelled.current,
      onProgress: (partial) => {
        if (cancelled.current) return;
        setStage({
          kind: 'matching',
          done: partial.filter(Boolean).length,
          total: items.length,
        });
      },
    });
    if (cancelled.current) return;
    const { rows, unmatched, echoes } = reviewFromMatches(items, results);
    const skipped = parsed.skipped + echoes;
    const notes: string[] = [];
    if (skipped > 0) {
      notes.push(`${plural(skipped, 'line was', 'lines were')} skipped as page text or repeats.`);
    }
    if (parsed.truncated > 0) {
      notes.push(
        `Only the first ${PASTE_MAX_ITEMS} titles were used; ${plural(parsed.truncated, 'title was', 'titles were')} left out.`
      );
    }
    setStage({ kind: 'review', rows, unmatched, note: notes.join(' ') || undefined });
  }

  if (stage.kind === 'matching') {
    const pct = stage.total > 0 ? Math.round((stage.done / stage.total) * 100) : 0;
    return (
      <div className="space-y-3" aria-live="polite">
        <p className="text-sm text-muted">
          Finding your books in the catalogs. Matched {stage.done} of {stage.total}.
        </p>
        <div
          role="progressbar"
          aria-label="Matching titles"
          aria-valuemin={0}
          aria-valuemax={stage.total}
          aria-valuenow={stage.done}
          className="h-2 w-full overflow-hidden rounded-full bg-elevated"
        >
          <div
            className="h-full rounded-full bg-accent transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    );
  }

  if (stage.kind === 'review') {
    return (
      <BulkReview
        initialRows={stage.rows}
        initialUnmatched={stage.unmatched}
        baselineRatings={baselineRatings}
        note={stage.note}
        onAdded={onAdded}
        onBack={() => setStage({ kind: 'input' })}
        backLabel="Edit the list"
      />
    );
  }

  return (
    <div className="space-y-4">
      <Field
        label="Your list"
        hint="One title per line. Add the author as Title by Author or Title - Author if you know it. A copied Kindle, Audible or Libby library page works too; we skip the buttons and dates."
      >
        {(p) => (
          <Textarea
            {...p}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            placeholder={
              'Project Hail Mary by Andy Weir\nCirce - Madeline Miller\nThe Remains of the Day'
            }
            className="resize-y font-mono text-[13px]"
          />
        )}
      </Field>

      <p className="text-xs text-faint" aria-live="polite">
        {count === 0
          ? 'Paste or type at least one title.'
          : `${plural(count, 'title', 'titles')} found${
              parsed.truncated > 0
                ? `, ${parsed.truncated} more past the ${PASTE_MAX_ITEMS} limit`
                : ''
            }.`}
      </p>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button onClick={() => void handleMatch()} disabled={count === 0}>
          Find these books
        </Button>
      </div>
    </div>
  );
}
