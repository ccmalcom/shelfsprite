/**
 * A cold-start reader for the recommend pipeline, and a routed fake catalog to run it against.
 *
 * The library is the QA account that found the cold-start problem (2026-10-30): six cozy-fantasy
 * books, so isColdStart holds. The catalog is fictional apart from the well-known titles the
 * title seed names. Its subject searches answer with the keyword-titled filler QA saw, a
 * preorder, and two nonfiction companions, and its title search answers the seeds.
 *
 * The catalog is routed by query rather than replayed by exact URL, because searchBooks issues
 * four differently-shaped requests per title; any request it does not know answers `{}`, which
 * every catalog reader treats as no results.
 */
import type { Seed } from './pglite';

export const COLD_PROFILED_AT = '2026-08-01 00:00:00';

const LIBRARY: Array<[string, string, number, string[]]> = [
  ['Legends & Lattes', 'Travis Baldree', 5, ['Fiction', 'Fantasy', 'Cozy fantasy']],
  ['The House in the Cerulean Sea', 'TJ Klune', 5, ['Fiction', 'Fantasy', 'Found family']],
  ['A Psalm for the Wild-Built', 'Becky Chambers', 4.5, ['Fiction', 'Science fiction']],
  ['The Spellshop', 'Sarah Beth Durst', 4, ['Fiction', 'Fantasy', 'Cozy fantasy']],
  ["Howl's Moving Castle", 'Diana Wynne Jones', 4.5, ['Juvenile fiction', 'Fantasy']],
  ['The Goblin Emperor', 'Katherine Addison', 4, ['Fiction', 'Fantasy']],
];

export function coldStartSeed(): Seed {
  return {
    books: LIBRARY.map(([title, author, rating], i) => ({
      id: 501 + i,
      user_id: 'local',
      title,
      author,
      isbn13: null,
      exclusive_shelf: 'read',
      // Half stars live in app_rating; Goodreads exports whole stars only.
      goodreads_rating: Math.floor(rating),
      app_rating: Number.isInteger(rating) ? null : rating,
      app_review: null,
      feedback_updated_at: null,
      date_read: '2026-01-01',
      date_added: '2026-01-01',
      page_count: 300,
      year_published: 2020,
      source: 'goodreads',
      exclude_from_profile: false,
      is_favorite: false,
      goodreads_book_id: `gr-cold-${i}`,
    })),
    enrichment: LIBRARY.map(([, , , subjects], i) => ({
      id: 501 + i,
      book_id: 501 + i,
      resolved_source: 'openlibrary',
      resolved_id: `/works/OLCOLD${i}W`,
      subjects,
      series: null,
      series_position: null,
      description: 'A gentle book.',
      cover_url: null,
      resolution_confidence: 0.95,
      confidence_label: 'HIGH',
      match_method: 'isbn:openlibrary',
      resolved_at: '2026-05-01T12:00:00',
    })),
    taste_traits: [
      {
        id: 51,
        user_id: 'local',
        claim: 'Loves low-stakes warmth and found family',
        polarity: 'positive',
        exhibits: [501, 502],
        contrasts: null,
        inference_confidence: 0.8,
        status: 'proposed',
        user_weight: 1,
        user_note: null,
        created_at: '2026-08-01T00:00:00',
        verdict_updated_at: null,
        reveal_line: null,
      },
    ],
    profile_meta: [
      {
        id: 51,
        user_id: 'local',
        last_profiled_at: COLD_PROFILED_AT,
        last_profile_kind: 'full',
        rec_feedback_updated_at: null,
        enrichment_corrected_at: null,
      },
    ],
  };
}

interface FakeBook {
  title: string;
  author: string;
  subjects: string[];
  /** Google's publishedDate: a year, a month or a full date. */
  published: string;
  /** Lowercased query fragments a title search answers this book for. */
  match?: string[];
  /** Subject slug (Open Library's form) whose searches list this book. */
  subject?: string;
}

const UNRELEASED_YEAR = new Date().getUTCFullYear() + 1;

/** Fictional filler, a preorder and companions under "Cozy fantasy", then the seeds' books. */
export const FAKE_CATALOG: FakeBook[] = [
  {
    title: 'Cozy Waystation Tea Shop at Bramblebridge',
    author: 'Willa Honeycomb',
    subjects: ['Fiction'],
    published: '2025',
    subject: 'cozy_fantasy',
  },
  {
    title: 'Tea Shop of Whimsy',
    author: 'Pippa Mill',
    subjects: ['Fiction'],
    published: '2026',
    subject: 'cozy_fantasy',
  },
  {
    title: 'Ninth Life of an Erstwhile Witch',
    author: 'R. Durst',
    subjects: ['Fiction', 'Fantasy'],
    published: String(UNRELEASED_YEAR),
    subject: 'cozy_fantasy',
  },
  {
    title: "Miyazaki and the Hero's Journey",
    author: 'Ann Critic',
    subjects: ['Performing Arts'],
    published: '2014',
    subject: 'cozy_fantasy',
  },
  {
    title: 'Ghiblipedia',
    author: 'Fan Writer',
    subjects: [],
    published: '2022',
    subject: 'cozy_fantasy',
  },
  {
    title: "Emily Wilde's Encyclopaedia of Faeries",
    author: 'Heather Fawcett',
    subjects: ['Fiction', 'Fantasy'],
    published: '2023-01-10',
    match: ["emily wilde's encyclopaedia of faeries"],
  },
  {
    // A study aid that names the seed: titleSeedMatch must not take it for the book.
    title: "Study Guide: Emily Wilde's Encyclopaedia of Faeries",
    author: 'SummaryCo',
    subjects: ['Study Aids'],
    published: '2024',
    match: ["emily wilde's encyclopaedia of faeries"],
  },
  {
    title: 'Nettle & Bone',
    author: 'T. Kingfisher',
    subjects: ['Fiction', 'Fantasy'],
    published: '2022',
    match: ['nettle & bone'],
  },
  {
    title: 'The Long Way to a Small, Angry Planet',
    author: 'Becky Chambers',
    subjects: ['Fiction', 'Science fiction'],
    published: '2015',
    match: ['the long way to a small, angry planet'],
  },
  {
    title: 'Under the Whispering Door',
    author: 'TJ Klune',
    subjects: ['Fiction', 'Fantasy'],
    published: '2021',
    match: ['under the whispering door'],
  },
  {
    // The only hit for this seed is someone else's summary, so the seed is dropped.
    title: 'Summary of Bookshops & Bonedust',
    author: 'QuickReads',
    subjects: ['Study Aids'],
    published: '2023',
    match: ['bookshops & bonedust'],
  },
];

function googleItem(b: FakeBook, i: number) {
  return {
    id: `cold-g${i}`,
    volumeInfo: {
      title: b.title,
      authors: [b.author],
      categories: b.subjects,
      publishedDate: b.published,
      description: `${b.title}, described.`,
      language: 'en',
    },
  };
}

function olDoc(b: FakeBook, i: number) {
  return {
    key: `/works/OLFAKE${i}W`,
    title: b.title,
    author_name: [b.author],
    first_publish_year: Number(b.published.slice(0, 4)),
    subject: b.subjects,
    language: ['eng'],
  };
}

function answer(url: URL): unknown {
  const hits = (pred: (b: FakeBook) => boolean) =>
    FAKE_CATALOG.map((b, i) => [b, i] as const).filter(([b]) => pred(b));
  if (url.host === 'www.googleapis.com') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const subject = /^subject:"(.+)"$/.exec(q);
    const found = subject
      ? hits((b) => b.subject === subject[1].replace(/[^a-z0-9]+/g, '_'))
      : hits((b) => (b.match ?? []).some((m) => q.includes(m)));
    return { items: found.map(([b, i]) => googleItem(b, i)) };
  }
  if (url.host === 'openlibrary.org') {
    const subject = /^\/subjects\/(.+)\.json$/.exec(url.pathname);
    if (subject) {
      return {
        works: hits((b) => b.subject === subject[1]).map(([b, i]) => ({
          key: `/works/OLFAKE${i}W`,
          title: b.title,
          authors: [{ name: b.author }],
          subject: b.subjects,
          first_publish_year: Number(b.published.slice(0, 4)),
        })),
      };
    }
    if (url.pathname === '/search.json') {
      const q = (url.searchParams.get('q') ?? url.searchParams.get('title') ?? '').toLowerCase();
      if (!q) return {};
      return {
        docs: hits((b) => (b.match ?? []).some((m) => q.includes(m))).map(([b, i]) => olDoc(b, i)),
      };
    }
  }
  return {};
}

/** Route every fetch to the fake catalog. Returns the restore function. */
export function installFakeCatalog(onCall?: (url: string) => void): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    onCall?.(url);
    return new Response(JSON.stringify(answer(new URL(url))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export const coldSeedQueriesResponse = {
  content: [
    {
      type: 'tool_use',
      name: 'propose_search_queries',
      input: { queries: [{ query: 'cozy fantasy found family', reason: 'fixture' }] },
    },
  ],
  usage: null,
};

export const titleSeedResponse = {
  content: [
    {
      type: 'tool_use',
      name: 'propose_adjacent_books',
      input: {
        books: [
          {
            title: "Emily Wilde's Encyclopaedia of Faeries",
            author: 'Heather Fawcett',
            reason: 'cozy scholarly fantasy',
          },
          { title: 'Nettle & Bone', author: 'T. Kingfisher', reason: 'warm, wry fantasy' },
          {
            title: 'The Long Way to a Small, Angry Planet',
            author: 'Becky Chambers',
            reason: 'more Chambers',
          },
          { title: 'Under the Whispering Door', author: 'TJ Klune', reason: 'more Klune' },
          { title: 'Bookshops & Bonedust', author: 'Travis Baldree', reason: 'more Baldree' },
          { title: 'Legends & Lattes', author: 'Travis Baldree', reason: 'already owned' },
          { title: 'A Book No Catalog Holds', author: 'Nobody Real', reason: 'unresolvable' },
          { title: 'Nettle & Bone', author: 'T. Kingfisher', reason: 'a repeat is dropped' },
          { title: '  ', author: 'No Title', reason: 'blank title is dropped' },
        ],
      },
    },
  ],
  usage: null,
};
