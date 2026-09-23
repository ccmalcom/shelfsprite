import { asc, eq } from 'drizzle-orm';
import { stringifyCanonical, type CanonicalCsvRecord } from './import-csv';
import { schema, type Db } from './db';
import { isScreenEnabled } from './screenSettings';
import { effectiveRating, pyJsonDumpsIndented, tsToIso } from './serialize';
import { effectiveTitleRating, type TitleEnrichmentRow, type TitleRow } from './titles';

type Book = typeof schema.books.$inferSelect;
type Signal = typeof schema.tasteSignal.$inferSelect;
type TitleRecRow = typeof schema.titleRecommendations.$inferSelect;

export interface ScreenExportData {
  titles: Array<{ title: TitleRow; enrichment: TitleEnrichmentRow | null }>;
  recommendations: TitleRecRow[];
}

function csvText(books: Book[]): string {
  const records: CanonicalCsvRecord[] = books.map((book) => ({
    title: book.title,
    author: book.author ?? '',
    additional_authors: book.additionalAuthors ?? '',
    isbn13: book.isbn13 ?? '',
    shelf: book.exclusiveShelf ?? '',
    rating: String(effectiveRating(book.appRating, book.goodreadsRating) ?? ''),
    review: book.appReview ?? '',
    date_read: book.dateRead ?? '',
    date_added: book.dateAdded ?? '',
    page_count: book.pageCount == null ? '' : String(book.pageCount),
    year_published: book.yearPublished == null ? '' : String(book.yearPublished),
  }));
  return stringifyCanonical(records);
}

function pythonUtcIso(now: Date): string {
  return `${now.toISOString().slice(0, -1)}000+00:00`;
}

function isTitleSignal(signal: Signal): boolean {
  return signal.targetTitleId != null || signal.targetKind === 'title';
}

function enrichmentOut(e: TitleEnrichmentRow) {
  return {
    wikidata_qid: e.wikidataQid,
    tvmaze_id: e.tvmazeId,
    wikipedia_page: e.wikipediaPage,
    genres: e.genres,
    directors: e.directors,
    creators: e.creators,
    writers: e.writers,
    countries: e.countries,
    original_language: e.originalLanguage,
    based_on: e.basedOn,
    main_subjects: e.mainSubjects,
    series: e.series,
    production_companies: e.productionCompanies,
    sitelinks: e.sitelinks,
    description: e.description,
    description_source: e.descriptionSource,
    description_url: e.descriptionUrl,
    image_url: e.imageUrl,
    resolution_confidence: e.resolutionConfidence,
    confidence_label: e.confidenceLabel,
    match_method: e.matchMethod,
    identity_source: e.identitySource,
    duplicate_of_title_id: e.duplicateOfTitleId,
    resolved_at: tsToIso(e.resolvedAt),
  };
}

function screenSection(screen: ScreenExportData, titleSignals: Signal[]) {
  return {
    version: 1,
    titles: screen.titles.map(({ title: t, enrichment }) => ({
      id: t.id,
      media_type: t.mediaType,
      title: t.title,
      year: t.year,
      status: t.status,
      letterboxd_rating: t.letterboxdRating,
      app_rating: t.appRating,
      effective_rating: effectiveTitleRating(t),
      letterboxd_review: t.letterboxdReview,
      app_review: t.appReview,
      last_watched_on: t.lastWatchedOn,
      letterboxd_uri: t.letterboxdUri,
      wikidata_qid: t.wikidataQid,
      tvmaze_id: t.tvmazeId,
      is_favorite: t.isFavorite,
      exclude_from_profile: t.excludeFromProfile,
      created_at: tsToIso(t.createdAt),
      enrichment: enrichment ? enrichmentOut(enrichment) : null,
    })),
    title_recommendations: screen.recommendations.map((r) => ({
      run_id: r.runId,
      rank: r.rank,
      media_type: r.mediaType,
      media_filter: r.mediaFilter,
      title: r.title,
      year: r.year,
      wikidata_qid: r.wikidataQid,
      tvmaze_id: r.tvmazeId,
      image_url: r.imageUrl,
      genres: r.genres,
      description: r.description,
      retrieval_pool: r.retrievalPool,
      seed_reason: r.seedReason,
      score: r.score,
      rationale: r.rationale,
      grounded_trait_ids: r.groundedTraitIds,
      grounded_book_ids: r.groundedBookIds,
      grounded_title_ids: r.groundedTitleIds,
      status: r.status,
      user_note: r.userNote,
      reject_reasons: r.rejectReasons,
      created_at: tsToIso(r.createdAt),
    })),
    taste_signals: titleSignals.map((signal) => ({
      direction: signal.direction,
      target_kind: signal.targetKind,
      target_title_id: signal.targetTitleId,
      snapshot: signal.snapshot,
      created_at: tsToIso(signal.createdAt),
    })),
  };
}

/**
 * The book part is byte-identical to the pre-screen export (pinned by
 * import-export-routes.test.ts). The screen section is appended LAST and only when `screen` is
 * non-null, so a user who never used ScreenSprite gets exactly today's bytes.
 */
export function exportJsonText(
  books: Book[],
  signals: Signal[],
  now = new Date(),
  screen: ScreenExportData | null = null
): string {
  const doc: Record<string, unknown> = {
    version: 1,
    exported_at: pythonUtcIso(now),
    books: books.map((book) => ({
      title: book.title,
      author: book.author,
      additional_authors: book.additionalAuthors,
      isbn13: book.isbn13,
      shelf: book.exclusiveShelf,
      goodreads_rating: book.goodreadsRating,
      app_rating: book.appRating,
      app_review: book.appReview,
      effective_rating: effectiveRating(book.appRating, book.goodreadsRating),
      is_favorite: book.isFavorite,
      exclude_from_profile: book.excludeFromProfile,
      date_read: book.dateRead,
      date_added: book.dateAdded,
      page_count: book.pageCount,
      year_published: book.yearPublished,
      source: book.source,
    })),
    taste_signals: signals
      .filter((signal) => !isTitleSignal(signal))
      .map((signal) => ({
        direction: signal.direction,
        target_kind: signal.targetKind,
        target_book_id: signal.targetBookId,
        snapshot: signal.snapshot,
        created_at: tsToIso(signal.createdAt),
      })),
  };
  if (screen) doc.screen = screenSection(screen, signals.filter(isTitleSignal));
  return pyJsonDumpsIndented(doc);
}

async function screenExportData(
  db: Db,
  userId: string,
  signals: Signal[]
): Promise<ScreenExportData | null> {
  const titles = await db
    .select({ title: schema.titles, enrichment: schema.titleEnrichment })
    .from(schema.titles)
    .leftJoin(schema.titleEnrichment, eq(schema.titleEnrichment.titleId, schema.titles.id))
    .where(eq(schema.titles.userId, userId))
    .orderBy(asc(schema.titles.id));
  const include =
    titles.length > 0 || signals.some(isTitleSignal) || (await isScreenEnabled(db, userId));
  if (!include) return null;
  const recommendations = await db
    .select()
    .from(schema.titleRecommendations)
    .where(eq(schema.titleRecommendations.userId, userId))
    .orderBy(asc(schema.titleRecommendations.id));
  return { titles, recommendations };
}

export async function buildExport(db: Db, userId: string, format: 'csv' | 'json'): Promise<string> {
  const books = await db
    .select()
    .from(schema.books)
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));
  if (format === 'csv') return csvText(books);
  const signals = await db
    .select()
    .from(schema.tasteSignal)
    .where(eq(schema.tasteSignal.userId, userId))
    .orderBy(asc(schema.tasteSignal.id));
  const screen = await screenExportData(db, userId, signals);
  return exportJsonText(books, signals, new Date(), screen);
}

export function utcDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll('-', '');
}
