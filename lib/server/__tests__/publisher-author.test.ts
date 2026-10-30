import { describe, expect, test } from 'vitest';
import type { Candidate, OpenLibraryIsbnCandidate } from '../catalog';
import type { Db } from '../db';
import { demoteBrandAuthorMatch, resolveOne, type EnrichmentCatalog } from '../enrichment';
import {
  candidateAuthor,
  candidatePublishers,
  hasPublisherAuthor,
  isPublisherLikeAuthor,
} from '../publisherAuthor';
import { assemble, type AssembleSignal, type PoolEntry } from '../recAssemble';

describe('isPublisherLikeAuthor', () => {
  test.each([
    'Blockbuster Story',
    'Trivion Books',
    'Acme Publishing',
    'Harbor Lights Publications',
    'Sunrise Media',
    'Moonlit Stories',
    'Evergreen Classics',
    'Pinecone Editions',
    'Storytime Studios',
    'Quill Productions',
    'Readwell, LLC',
    'Booksmith Inc.',
    'Paperleaf Ltd',
    // An ambiguous word corroborated by a brand word, a leading "The" or both.
    'Golden Press',
    'Oxford University Press',
    'Penguin Press',
    'The Story House',
    'Kindle Story',
  ])('%s reads as a publisher or brand', (author) => {
    expect(isPublisherLikeAuthor(author)).toBe(true);
  });

  test.each([
    // Real surnames that collide with publisher words.
    'Mary Press',
    'Silas House',
    'Tom House',
    'Jennifer Story',
    'Kelly Studio',
    'Ann Library',
    // Whole words only.
    'David Storey',
    'Arthur Golden',
    'Steven Pressfield',
    'Ruth Housman',
    // "Last, First" leaves the collision first.
    'Press, Mary',
    // Ordinary names and empties.
    'Carter Vane',
    'Ursula K. Le Guin',
    'N. K. Jemisin',
    'Author',
    '',
    null,
    undefined,
  ])('%s survives', (author) => {
    expect(isPublisherLikeAuthor(author)).toBe(false);
  });

  test('an ambiguous suffix needs the record to corroborate it', () => {
    expect(isPublisherLikeAuthor('Harbor Press')).toBe(false);
    expect(isPublisherLikeAuthor('Harbor Press', ['Harbor Press'])).toBe(true);
    // Legal-form tails are ignored when comparing with the publisher.
    expect(isPublisherLikeAuthor('Harbor Press', ['Harbor Press, LLC'])).toBe(true);
    // A real person named Press whose publisher is someone else.
    expect(isPublisherLikeAuthor('Mary Press', ['Tor Books'])).toBe(false);
  });

  test('author equal to publisher alone: a self-published person survives, a brand does not', () => {
    expect(isPublisherLikeAuthor('Andy Weir', ['Andy Weir'])).toBe(false);
    expect(isPublisherLikeAuthor('Cruickshankcata', ['Cruickshankcata'])).toBe(true);
    expect(isPublisherLikeAuthor('Pinnacle Reads', ['Pinnacle Reads'])).toBe(true);
    expect(isPublisherLikeAuthor('Pinnacle Reads')).toBe(false);
  });
});

describe('candidatePublishers / candidateAuthor', () => {
  test('reads Google, Open Library search and Open Library ISBN payloads', () => {
    expect(candidatePublishers({ volumeInfo: { publisher: 'Blockbuster Story' } })).toEqual([
      'Blockbuster Story',
    ]);
    expect(candidatePublishers({ publisher: ['Tor', ' ', 'Orbit'] })).toEqual(['Tor', 'Orbit']);
    expect(
      candidatePublishers({ isbn: 'x', record: { publishers: [{ name: 'Ace Books' }] } })
    ).toEqual(['Ace Books']);
    expect(candidatePublishers(null)).toEqual([]);
    expect(candidatePublishers('raw')).toEqual([]);

    expect(candidateAuthor({ author: 'Carter Vane' })).toBe('Carter Vane');
    expect(candidateAuthor({ raw: { record: { authors: [{ name: 'Blockbuster Story' }] } } })).toBe(
      'Blockbuster Story'
    );
    expect(candidateAuthor({ raw: {} })).toBeNull();
  });

  test('hasPublisherAuthor combines the author with the record publisher', () => {
    expect(
      hasPublisherAuthor({ author: 'Harbor Press', raw: { publisher: ['Harbor Press'] } })
    ).toBe(true);
    expect(hasPublisherAuthor({ author: 'Mary Press', raw: { publisher: ['Tor'] } })).toBe(false);
  });
});

function cand(title: string, author: string | null, raw: unknown = {}): Candidate {
  return {
    source: 'googlebooks',
    resolved_id: `${title}|${author}`,
    title,
    author,
    subjects: ['Fiction'],
    description: 'A description.',
    cover_url: null,
    year: 2024,
    language: 'en',
    raw,
  };
}

const emptySignal: AssembleSignal = {
  library_keys: new Set(),
  library_isbns: new Set(),
  library_series: new Map(),
  library_titles: [],
  library_languages: new Set(['en']),
  library_authors: new Set(),
};

describe('assemble drops brand-authored candidates', () => {
  test('the QA case is dropped while the real-author edition and a Mary Press survive', () => {
    const meta: PoolEntry[] = [
      [
        cand('The Enchanted Tea House', 'Blockbuster Story', {
          volumeInfo: { publisher: 'Blockbuster Story' },
        }),
        'subject:cozy fantasy',
      ],
      [cand('Lock In Trivia', 'Trivion Books'), 'subject:cozy fantasy'],
      [cand('The Enchanted Tea House', 'Carter Vane'), 'subject:cozy fantasy'],
      [cand('A Quiet Kettle', 'Mary Press'), 'subject:cozy fantasy'],
    ];
    const out = assemble(meta, [], emptySignal, 60);
    expect(out.map((c) => [c.title, c.author])).toEqual([
      ['The Enchanted Tea House', 'Carter Vane'],
      ['A Quiet Kettle', 'Mary Press'],
    ]);
  });
});

function olIsbn(raw: Record<string, unknown> = {}): OpenLibraryIsbnCandidate {
  return {
    source: 'openlibrary',
    resolved_id: '/books/OL1M',
    title: 'The Enchanted Tea House',
    subjects: ['Cozy fantasy'],
    cover_url: null,
    description: null,
    raw: { isbn: '9780000000001', record: raw as any },
  };
}

function catalogOf(values: {
  olIsbn?: OpenLibraryIsbnCandidate | null;
  olSearch?: Candidate[];
  googleSearch?: Candidate[];
}): EnrichmentCatalog {
  return {
    openlibraryByIsbn: async () => values.olIsbn ?? null,
    googleBooksByIsbn: async () => null,
    openlibraryEnrichmentSearch: async () => values.olSearch ?? [],
    googleBooksEnrichmentSearch: async () => values.googleSearch ?? [],
  };
}

const db = {} as Db;

describe('enrichment keeps a brand-author match LOW', () => {
  test('an ISBN match for a book whose author is a brand is LOW, not HIGH', async () => {
    const result = await resolveOne(
      db,
      { title: 'The Enchanted Tea House', author: 'Blockbuster Story', isbn13: '9780000000001' },
      catalogOf({ olIsbn: olIsbn() })
    );
    expect(result.method).toBe('isbn:openlibrary');
    expect(result.label).toBe('LOW');
  });

  test('an ISBN match for a real author stays HIGH even when the record names a brand', async () => {
    const result = await resolveOne(
      db,
      { title: 'The Enchanted Tea House', author: 'Carter Vane', isbn13: '9780000000001' },
      catalogOf({ olIsbn: olIsbn({ authors: [{ name: 'Blockbuster Story' }] }) })
    );
    expect(result.label).toBe('HIGH');
  });

  test('an author-less book matched only through a brand author is LOW', async () => {
    const result = await resolveOne(
      db,
      { title: 'The Enchanted Tea House', author: null, isbn13: '9780000000001' },
      catalogOf({ olIsbn: olIsbn({ authors: [{ name: 'Blockbuster Story' }] }) })
    );
    expect(result.label).toBe('LOW');
  });

  test('a search match that agrees on a brand author is LOW, not MEDIUM', async () => {
    const result = await resolveOne(
      db,
      { title: 'The Enchanted Tea House', author: 'Harbor Press', isbn13: null },
      catalogOf({
        olSearch: [
          cand('The Enchanted Tea House', 'Harbor Press', { publisher: ['Harbor Press'] }),
        ],
      })
    );
    expect(result.method).toBe('search:openlibrary');
    expect(result.candidate?.title).toBe('The Enchanted Tea House');
    expect(result.label).toBe('LOW');
  });

  test('a real author named Press keeps a MEDIUM search match', async () => {
    const result = await resolveOne(
      db,
      { title: 'A Quiet Kettle', author: 'Mary Press', isbn13: null },
      catalogOf({ olSearch: [cand('A Quiet Kettle', 'Mary Press', { publisher: ['Tor'] })] })
    );
    expect(result.label).toBe('MEDIUM');
  });

  test('demoteBrandAuthorMatch leaves LOW and unresolved results alone', () => {
    const unresolved = { candidate: null, label: 'NONE' as const, method: 'unresolved' as const };
    expect(demoteBrandAuthorMatch({ author: 'Blockbuster Story' }, unresolved)).toBe(unresolved);
  });
});
