'use client';

import { useState } from 'react';
import { Badge, Button, Input } from '@/components/ui';
import {
  MAX_PREFER_ENTRIES,
  type PreferenceSuggestion,
  type PreferenceSuggestions,
} from '@/lib/api';
// Bundle-safe: exclusions.ts imports only dedup.ts, and both are dependency-free. Same
// precedent as lib/server/rating.ts in StarRating. It is imported rather than
// reimplemented because a second copy of the conflict rule is what put this warning out
// of step with the server in the first place.
import { authorExcluded, subjectExcluded } from '@/lib/server/exclusions';

const fold = (s: string) => s.trim().toLowerCase();
const has = (list: string[], value: string) => list.some((x) => fold(x) === fold(value));

interface GroupProps {
  label: string;
  addLabel: string;
  placeholder: string;
  values: string[];
  excluded: string[];
  suggestions: PreferenceSuggestion[];
  /** True for subjects, false for authors — mirrors cleanDirectiveConstraints, which
   *  lowercases prefer_subjects and preserves prefer_authors' case. Without this the
   *  chip a reader adds silently changes case on their next page load. */
  lowercase: boolean;
  /** The recommender's own exclusion rule for this family -- surname matching for
   *  authors, whole-word-inside-subject for subjects. Never a string compare. */
  isExcluded: (value: string, excluded: string[]) => boolean;
  disabled: boolean;
  onChange: (next: string[]) => void;
}

function Group({
  label,
  addLabel,
  placeholder,
  values,
  excluded,
  suggestions,
  lowercase,
  isExcluded,
  disabled,
  onChange,
}: GroupProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputId = `favorites-${addLabel.replace(/\s+/g, '-')}`;

  function add(raw: string): void {
    // Apply the SAME normalization cleanDirectiveConstraints will: collapse internal
    // whitespace, and lowercase for subjects. Otherwise the chip a reader just added
    // reads "Space Opera" until they reload and it silently becomes "space opera" —
    // a case flip with no explanation, which reads as a bug. A "From your library"
    // suggestion keeps the catalog's own casing on its label (enrichment.subjects is
    // stored as the catalog returned it); adding it stores the lowercase form, and
    // the row's own filter folds case, so it still disappears from the row.
    const collapsed = raw.trim().replace(/\s+/g, ' ');
    const value = lowercase ? collapsed.toLowerCase() : collapsed;
    if (!value) return;
    if (has(values, value)) {
      setDraft('');
      setError(null);
      return;
    }
    if (values.length >= MAX_PREFER_ENTRIES) {
      setError(`You can save up to ${MAX_PREFER_ENTRIES}. Remove one first.`);
      return;
    }
    // The server drops a preference that collides with an exclusion. Say so here
    // instead, so the reader learns why rather than watching it vanish on save. Matched
    // the way the recommender matches, so the warning fires on the near-misses that
    // actually bite: 'Brandon Sanderson' against an exclusion of 'sanderson', or 'space
    // opera' against an exclusion of 'opera'. A full-string compare accepted both, the
    // server then dropped the favorite on save, and the reader was told nothing.
    if (isExcluded(value, excluded)) {
      setError(`"${value}" is already on your avoid list. Remove it there first.`);
      return;
    }
    setError(null);
    setDraft('');
    onChange([...values, value]);
  }

  // Derived from the current list, so accepting a suggestion removes it from the row.
  const open = suggestions.filter((s) => !has(values, s.value));

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-text" htmlFor={inputId}>
        {label}
      </label>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((v) => (
            <Badge key={v} variant="accent">
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                className="ml-1.5 text-muted hover:text-text disabled:opacity-50"
                disabled={disabled}
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                &times;
              </button>
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          id={inputId}
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(draft);
            }
          }}
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={addLabel}
          disabled={disabled}
          onClick={() => add(draft)}
        >
          Add
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {open.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted">From your library</p>
          <div className="flex flex-wrap gap-2">
            {open.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-label={`Add ${s.value}`}
                disabled={disabled}
                onClick={() => add(s.value)}
                className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              >
                <Badge>
                  {s.value} &middot; {s.count}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The favorites editor. Controlled: it holds no server state and performs no
 * fetching, because CustomInstructions must stay the single owner of the directive
 * record (PUT /directive replaces nl_text and constraints wholesale, so two
 * independent writers would clobber each other).
 *
 * PreferenceSuggestions here is the lib/api.ts declaration, NOT the
 * lib/server/preferenceSuggest.ts one: that module imports db.ts, which would pull
 * drizzle and schema.ts into the browser bundle.
 */
export default function FavoritesFields({
  authors,
  subjects,
  excludeAuthors,
  excludeSubjects,
  suggestions,
  disabled = false,
  onChange,
}: {
  authors: string[];
  subjects: string[];
  excludeAuthors: string[];
  excludeSubjects: string[];
  suggestions: PreferenceSuggestions | undefined;
  /** True while the directive record is still loading. Editing then would build a
   *  constraints object out of an empty placeholder and drop the stored exclusions. */
  disabled?: boolean;
  onChange: (next: { authors: string[]; subjects: string[] }) => void;
}) {
  return (
    <div className="space-y-4">
      <Group
        label="Favorite authors"
        addLabel="Add favorite author"
        placeholder="Ursula K. Le Guin"
        values={authors}
        excluded={excludeAuthors}
        suggestions={suggestions?.authors ?? []}
        lowercase={false}
        isExcluded={authorExcluded}
        disabled={disabled}
        onChange={(next) => onChange({ authors: next, subjects })}
      />
      <Group
        label="Favorite genres & subjects"
        addLabel="Add favorite subject"
        placeholder="space opera"
        values={subjects}
        excluded={excludeSubjects}
        suggestions={suggestions?.subjects ?? []}
        lowercase
        isExcluded={subjectExcluded}
        disabled={disabled}
        onChange={(next) => onChange({ authors, subjects: next })}
      />
    </div>
  );
}
