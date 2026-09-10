'use client';

import { useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import {
  getDirective,
  putDirective,
  deleteDirective,
  getPreferenceSuggestions,
  DIRECTIVE_KEY,
  DIRECTIVE_SUGGESTIONS_KEY,
  type Directive,
  type DirectiveConstraints,
  type PreferenceSuggestions,
} from '@/lib/api';
import { Button, Textarea, Card, Badge } from '@/components/ui';
import DirectiveChat from '@/components/DirectiveChat';
import FavoritesFields from '@/components/FavoritesFields';

function constraintChips(c: DirectiveConstraints): string[] {
  const chips: string[] = [];
  if (c.languages?.length) chips.push(`languages: ${c.languages.join(', ')}`);
  if (c.min_year != null) chips.push(`from ${c.min_year}`);
  if (c.max_year != null) chips.push(`to ${c.max_year}`);
  if (c.exclude_subjects?.length) chips.push(`avoid: ${c.exclude_subjects.join(', ')}`);
  if (c.exclude_authors?.length) chips.push(`skip authors: ${c.exclude_authors.join(', ')}`);
  return chips;
}

export default function CustomInstructions() {
  const { mutate } = useSWRConfig();
  const { data } = useSWR<Directive>(DIRECTIVE_KEY, getDirective);
  const { data: suggestions } = useSWR<PreferenceSuggestions>(
    DIRECTIVE_SUGGESTIONS_KEY,
    getPreferenceSuggestions
  );
  const [text, setText] = useState<string | null>(null);
  const [constraints, setConstraints] = useState<DirectiveConstraints | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed local edit state from the fetched record once.
  const effectiveText = text ?? data?.nl_text ?? '';
  const effectiveConstraints = constraints ?? data?.constraints ?? {};
  const chips = constraintChips(effectiveConstraints);

  // useSWR reports `undefined` while the first request is in flight, which the fallbacks
  // above render as an EMPTY record -- indistinguishable from a reader who has no
  // directive. Editing against that placeholder is destructive in two ways: a favorite
  // added during the window builds a constraints object holding only that favorite, and
  // the fetched exclude_*/languages are then never merged in; and Save with everything
  // still blank takes the delete path below and erases a directive that does exist.
  // Neither is exotic -- both need only a slow first paint. So no editing until loaded.
  const loaded = data !== undefined;

  // Favorites edit the SAME constraints object the prose shares, so Save writes both
  // in one PUT. PUT /directive replaces the record wholesale; a second writer would
  // clobber whichever field it did not own.
  //
  // Empty lists are OMITTED rather than sent as [], matching how
  // cleanDirectiveConstraints stores them — so the empty-record check in save() can
  // just count keys instead of inspecting each one.
  function setFavorites(next: { authors: string[]; subjects: string[] }): void {
    const merged: DirectiveConstraints = { ...effectiveConstraints };
    if (next.authors.length) merged.prefer_authors = next.authors;
    else delete merged.prefer_authors;
    if (next.subjects.length) merged.prefer_subjects = next.subjects;
    else delete merged.prefer_subjects;
    setConstraints(merged);
  }

  async function save() {
    setSaving(true);
    try {
      const text = effectiveText.trim();
      // PUT /directive 422s when text and cleaned constraints are both empty, and
      // there is no catch here — the reader would get a silent no-op. Removing your
      // last favorite is a normal action, so route it to the delete path instead.
      // `loaded` is re-checked rather than trusted from the disabled button: an
      // in-flight revalidation must never be able to route Save into a DELETE.
      if (loaded && !text && Object.keys(effectiveConstraints).length === 0) {
        await deleteDirective();
      } else {
        await putDirective({ nl_text: text || null, constraints: effectiveConstraints });
      }
      // Suggestions are computed server-side minus the reader's current lists, so a
      // save changes them: an accepted suggestion must be replaced by the next
      // candidate rather than just leaving a shorter row.
      await Promise.all([mutate(DIRECTIVE_KEY), mutate(DIRECTIVE_SUGGESTIONS_KEY)]);
      setText(null);
      setConstraints(null);
    } finally {
      setSaving(false);
    }
  }

  async function clearAll() {
    setSaving(true);
    try {
      await deleteDirective();
      // Clearing the record un-excludes every value it held, so the suggestion row
      // must be refetched too.
      await Promise.all([mutate(DIRECTIVE_KEY), mutate(DIRECTIVE_SUGGESTIONS_KEY)]);
      setText('');
      setConstraints({});
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-bold text-text">Custom instructions</h3>
        <Button variant="ghost" size="sm" disabled={!loaded} onClick={() => setChatOpen(true)}>
          Help me write this
        </Button>
      </div>
      <p className="text-sm text-muted">
        Tell the recommender what you want in your own words: &ldquo;more nonfiction this
        year&rdquo;, &ldquo;nothing bleak&rdquo;, &ldquo;short books&rdquo;. This steers every
        recommendation.
      </p>
      <Textarea
        rows={4}
        value={effectiveText}
        disabled={!loaded}
        onChange={(e) => setText(e.target.value)}
        placeholder="More character-driven literary fiction. No grimdark. Keep it under 400 pages."
      />
      <FavoritesFields
        authors={effectiveConstraints.prefer_authors ?? []}
        subjects={effectiveConstraints.prefer_subjects ?? []}
        excludeAuthors={effectiveConstraints.exclude_authors ?? []}
        excludeSubjects={effectiveConstraints.exclude_subjects ?? []}
        suggestions={suggestions}
        disabled={!loaded}
        onChange={setFavorites}
      />
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <Badge key={c}>{c}</Badge>
          ))}
        </div>
      )}
      <div className="flex gap-3">
        <Button onClick={save} loading={saving} disabled={saving || !loaded}>
          Save
        </Button>
        {(data?.nl_text || Object.keys(data?.constraints ?? {}).length > 0) && (
          <Button variant="ghost" onClick={clearAll} disabled={saving || !loaded}>
            Clear
          </Button>
        )}
      </div>
      {chatOpen && (
        <DirectiveChat
          currentText={effectiveText}
          onClose={() => setChatOpen(false)}
          onApply={(proposed, c) => {
            setText(proposed);
            // DISTILL_TOOL's schema declares only the hard filters, so a draft never
            // carries prefer_authors/prefer_subjects and replacing constraints wholesale
            // silently discarded the reader's favorites -- saved ones included. Carry
            // them across. A draft that adds a conflicting exclusion still wins:
            // cleanDirectiveConstraints drops the colliding favorite on save, which is
            // the documented hard-filter-outranks-soft-boost rule.
            const merged: DirectiveConstraints = { ...c };
            const { prefer_authors, prefer_subjects } = effectiveConstraints;
            if (prefer_authors?.length) merged.prefer_authors = prefer_authors;
            if (prefer_subjects?.length) merged.prefer_subjects = prefer_subjects;
            setConstraints(merged);
            setChatOpen(false);
          }}
        />
      )}
    </Card>
  );
}
