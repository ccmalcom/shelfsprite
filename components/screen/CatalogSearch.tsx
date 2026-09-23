'use client';

import { useState, type FormEvent } from 'react';
import { screenApi, type MediaType, type ScreenCandidate } from '@/lib/api';
import { Button, Input } from '@/components/ui';
import TitleTile from '@/components/screen/TitleTile';
import { errorMessage, mediaLabel, titleLabel } from '@/lib/screen';

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; results: ScreenCandidate[] };

interface Props {
  initialQuery?: string;
  initialType?: MediaType;
  pickLabel: string;
  onPick: (candidate: ScreenCandidate) => void;
  busy?: boolean;
}

/**
 * Catalog search for manual add and correction (spec §3.5, §4.4). Runs on submit only: the
 * route is rate-limited. Results show no description, since a description must carry its
 * source line (§7.9) and a result list has no room for one.
 */
export default function CatalogSearch({
  initialQuery = '',
  initialType = 'movie',
  pickLabel,
  onPick,
  busy = false,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [type, setType] = useState<MediaType>(initialType);
  const [state, setState] = useState<SearchState>({ kind: 'idle' });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'done', results: await screenApi.search(q, type) });
    } catch (err) {
      setState({
        kind: 'error',
        message: errorMessage(err, 'The search did not finish. Try again.'),
      });
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <div
          role="radiogroup"
          aria-label="Search for"
          className="inline-flex rounded-lg border border-border bg-elevated p-0.5"
        >
          {(['movie', 'tv'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              onClick={() => setType(t)}
              className={[
                'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                type === t ? 'bg-surface text-text shadow-sm' : 'text-muted hover:text-text',
              ].join(' ')}
            >
              {t === 'tv' ? 'TV show' : 'Film'}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            aria-label="Title"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={type === 'tv' ? 'e.g. Severance' : 'e.g. Heat 1995'}
          />
          <Button
            type="submit"
            loading={state.kind === 'loading'}
            disabled={!query.trim() || state.kind === 'loading'}
          >
            Search
          </Button>
        </div>
      </form>

      {state.kind === 'error' && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}
      {state.kind === 'done' && state.results.length === 0 && (
        <p className="text-sm text-muted">No matches. Try the original title, or add the year.</p>
      )}
      {state.kind === 'done' && state.results.length > 0 && (
        <ul className="space-y-3">
          {state.results.map((c) => {
            const label = titleLabel(c.title, c.year);
            const people = (c.media_type === 'tv' ? c.creators : c.directors).slice(0, 2);
            return (
              <li
                key={`${c.wikidata_qid ?? 'none'}-${c.tvmaze_id ?? 'none'}`}
                className="flex items-center gap-3 rounded-lg border border-border p-3"
              >
                <TitleTile
                  title={c.title}
                  year={c.year}
                  mediaType={c.media_type}
                  imageUrl={c.image_url}
                  className="w-12 shrink-0"
                  sizes="48px"
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-text">{label}</p>
                  <p className="text-xs text-faint">
                    {[mediaLabel(c.media_type), ...people].join(' \u00B7 ')}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`${pickLabel}: ${label}`}
                  onClick={() => onPick(c)}
                >
                  {pickLabel}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
