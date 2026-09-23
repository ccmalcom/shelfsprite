import { describe, test, expect } from 'vitest';
import {
  applyPersonCap,
  applyScreenDirective,
  assembleScreenPool,
  capHits,
  hydrate,
  languageCode,
  mergeHits,
  type MergedHit,
  type PoolHit,
  type ScreenPoolCandidate,
} from '../screenAssemble';
import { normalizeTitleKey } from '../titles';
import { candidate, fakeScreenPort, OPEN_DEADLINE } from './helpers/screenRecFixtures';

function hit(qid: string, over: Partial<PoolHit> = {}): PoolHit {
  return {
    qid,
    media_type: 'movie',
    tvmaze_id: null,
    label: `Film ${qid}`,
    year: 2010,
    sitelinks: 20,
    enwiki: true,
    pool: 'metadata',
    seed_reason: 'metadata:people=1;genres=1',
    adaptation: null,
    ...over,
  };
}

const noOwned = {
  owned_qids: new Set<string>(),
  owned_tvmaze_ids: new Set<number>(),
  owned_keys: new Set<string>(),
};

function cand(qid: string, over: Partial<ScreenPoolCandidate> = {}): ScreenPoolCandidate {
  return {
    ...candidate({ title: `Film ${qid}`, wikidata_qid: qid, year: 2010 }),
    retrieval_pool: 'metadata',
    seed_reason: '',
    adaptation: null,
    ...over,
  };
}

describe('mergeHits', () => {
  test('applies the popularity floor, the TV crosswalk rule and every owned key', () => {
    const merged = mergeHits(
      [
        [
          hit('Q1', { sitelinks: 9 }),
          hit('Q2', { enwiki: false }),
          hit('Q3', { media_type: 'tv', tvmaze_id: null }),
          hit('Q4'),
          hit('Q5', { media_type: 'tv', tvmaze_id: 50 }),
          hit('Q6', { label: 'Arrival', year: 2016 }),
          hit('Q7'),
        ],
      ],
      {
        owned_qids: new Set(['Q4']),
        owned_tvmaze_ids: new Set([50]),
        owned_keys: new Set([normalizeTitleKey('Arrival', 2016)]),
      }
    );
    expect(merged.map((m) => m.qid)).toEqual(['Q7']);
  });

  test('a candidate in two pools is "multiple" and keeps its adaptation provenance', () => {
    const adaptation = { book_id: 1, book_title: 'Dune', source_qid: 'Q70', via: 'work' as const };
    const merged = mergeHits(
      [
        [hit('Q1', { pool: 'adaptation', adaptation, seed_reason: 'adaptation:work=Q70;book=1' })],
        [hit('Q1', { pool: 'claude_seed' })],
        [hit('Q2', { pool: 'claude_seed' })],
      ],
      noOwned
    );
    expect(merged).toEqual([
      expect.objectContaining({
        qid: 'Q1',
        retrieval_pool: 'multiple',
        adaptation,
        seed_reason: 'adaptation:work=Q70;book=1',
      }),
      expect.objectContaining({ qid: 'Q2', retrieval_pool: 'claude_seed' }),
    ]);
  });

  test('a second item with the same title and year is dropped', () => {
    const merged = mergeHits(
      [[hit('Q1', { label: 'Solaris', year: 1972 }), hit('Q2', { label: 'Solaris', year: 1972 })]],
      noOwned
    );
    expect(merged.map((m) => m.qid)).toEqual(['Q1']);
  });
});

describe('capHits', () => {
  const mk = (n: number, pool: MergedHit['retrieval_pool']) =>
    Array.from(
      { length: n },
      (_, i) => ({ ...hit(`Q${pool}${i}`), retrieval_pool: pool }) as unknown as MergedHit
    );

  test('under the cap is untouched', () => {
    const hits = mk(5, 'metadata');
    expect(capHits(hits, 60)).toBe(hits);
  });

  test('multiple first, then the seed reserve, adaptation share, metadata, backfill', () => {
    const hits = [
      ...mk(40, 'metadata'),
      ...mk(30, 'adaptation'),
      ...mk(25, 'claude_seed'),
      ...mk(2, 'multiple'),
    ];
    const out = capHits(hits, 60);
    const count = (p: string) => out.filter((h) => h.retrieval_pool === p).length;
    expect(out).toHaveLength(60);
    expect(count('multiple')).toBe(2);
    expect(count('claude_seed')).toBe(18); // round(60 * 0.3)
    expect(count('adaptation')).toBe(24); // round(60 * 0.4)
    expect(count('metadata')).toBe(16);
  });

  test('slack is backfilled from leftover adaptation, then seeds', () => {
    const out = capHits(
      [...mk(2, 'metadata'), ...mk(40, 'adaptation'), ...mk(40, 'claude_seed')],
      60
    );
    expect(out).toHaveLength(60);
    expect(out.filter((h) => h.retrieval_pool === 'adaptation').length).toBe(40);
  });
});

describe('hydrate', () => {
  test('uses fetched metadata, falls back to the pool label, drops what has no title', async () => {
    const merged: MergedHit[] = [
      { ...hit('Q1'), retrieval_pool: 'metadata' } as unknown as MergedHit,
      { ...hit('Q2', { label: 'Label Only' }), retrieval_pool: 'metadata' } as unknown as MergedHit,
      { ...hit('Q3', { label: null }), retrieval_pool: 'metadata' } as unknown as MergedHit,
      {
        ...hit('Q4', { media_type: 'tv', tvmaze_id: 77 }),
        retrieval_pool: 'claude_seed',
      } as unknown as MergedHit,
    ];
    const port = fakeScreenPort({
      metadata: {
        Q1: candidate({
          title: 'Real Title',
          wikidata_qid: 'Q1',
          year: 2011,
          genres: ['drama film'],
          image_url: 'https://upload.wikimedia.org/x.jpg',
        }),
        Q4: candidate({ title: 'A Show', wikidata_qid: 'Q4', media_type: 'tv', tvmaze_id: null }),
      },
    });
    const out = await hydrate(port, merged, OPEN_DEADLINE);
    expect(port.metadataCalls).toEqual([['Q1', 'Q2', 'Q3', 'Q4']]);
    expect(out.map((c) => [c.wikidata_qid, c.title, c.year])).toEqual([
      ['Q1', 'Real Title', 2011],
      ['Q2', 'Label Only', 2010],
      ['Q4', 'A Show', 2010],
    ]);
    expect(out[0].genres).toEqual(['drama film']);
    expect(out[2]).toMatchObject({ media_type: 'tv', tvmaze_id: 77 });
  });

  test('a retryable metadata failure still serves minimal candidates', async () => {
    const out = await hydrate(
      fakeScreenPort({ metadataRetryable: true }),
      [{ ...hit('Q1'), retrieval_pool: 'metadata' } as unknown as MergedHit],
      OPEN_DEADLINE
    );
    expect(out).toEqual([
      expect.objectContaining({ wikidata_qid: 'Q1', title: 'Film Q1', genres: [], sitelinks: 20 }),
    ]);
  });
});

describe('filters', () => {
  test('languageCode accepts ISO codes and English labels; unknown is null', () => {
    expect(languageCode('fr')).toBe('fr');
    expect(languageCode('French')).toBe('fr');
    expect(languageCode('Mandarin Chinese')).toBe('zh');
    expect(languageCode('English language')).toBe('en');
    expect(languageCode('Klingon')).toBeNull();
    expect(languageCode(null)).toBeNull();
  });

  test('the directive maps years, subjects, source authors and languages; missing values pass', () => {
    const cands = [
      cand('Q1', { year: 1985 }),
      cand('Q2', { genres: ['horror film'] }),
      cand('Q3', { main_subjects: ['war'] }),
      cand('Q4', { based_on: [{ qid: 'Q9', title: 'It', author: 'Stephen King' }] }),
      cand('Q5', { original_language: 'Japanese' }),
      cand('Q6', { year: null, original_language: 'Klingon' }),
      cand('Q7', { original_language: 'en' }),
    ];
    const out = applyScreenDirective(cands, {
      min_year: 1990,
      exclude_subjects: ['horror', 'war'],
      exclude_authors: ['king'],
      languages: ['en'],
    });
    expect(out.map((c) => c.wikidata_qid)).toEqual(['Q6', 'Q7']);
    expect(applyScreenDirective(cands, {})).toBe(cands);
  });

  test('at most two per first-listed director or creator', () => {
    const out = applyPersonCap([
      cand('Q1', { directors: ['Denis Villeneuve'] }),
      cand('Q2', { directors: ['denis villeneuve '] }),
      cand('Q3', { directors: ['Denis Villeneuve'] }),
      cand('Q4', { media_type: 'tv', creators: ['Denis Villeneuve'] }),
      cand('Q5', {}),
    ]);
    expect(out.map((c) => c.wikidata_qid)).toEqual(['Q1', 'Q2', 'Q5']);
  });
});

describe('assembleScreenPool', () => {
  test('media filter, owned re-check after hydration, cap', async () => {
    const port = fakeScreenPort({
      metadata: {
        Q1: candidate({ title: 'Toy Story', wikidata_qid: 'Q1', year: 1995 }),
        Q2: candidate({ title: 'New Film', wikidata_qid: 'Q2', year: 2020 }),
      },
    });
    const out = await assembleScreenPool(
      port,
      [
        [
          hit('Q1', { label: 'Toy Story (film)', year: 1995 }),
          hit('Q2'),
          hit('Q3', { media_type: 'tv', tvmaze_id: 3 }),
        ],
      ],
      {
        ...noOwned,
        owned_keys: new Set([normalizeTitleKey('Toy Story', 1995)]),
        directive_constraints: {},
      },
      'movie',
      OPEN_DEADLINE
    );
    expect(out.map((c) => c.wikidata_qid)).toEqual(['Q2']);
    expect(port.metadataCalls).toEqual([['Q1', 'Q2']]);
  });
});
