import { eq } from 'drizzle-orm';
import { schema, type Db } from '../../db';
import type { ClaudeClient, ClaudeMessage } from '../../claude';

/** A fixed toggle stamp, so tests can compare `screen_toggled_at` exactly. */
export const TOGGLED_AT = '2026-07-05 10:00:00';

/** Upserts the user's settings row with the ScreenSprite flag and toggle stamp. */
export async function setScreen(
  db: Db,
  enabled: boolean,
  userId = 'local',
  toggledAt: string = TOGGLED_AT
): Promise<void> {
  const rows = await db
    .select({ id: schema.userSettings.id })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  if (rows[0]) {
    await db
      .update(schema.userSettings)
      .set({ screenEnabled: enabled, screenToggledAt: toggledAt })
      .where(eq(schema.userSettings.id, rows[0].id));
  } else {
    await db
      .insert(schema.userSettings)
      .values({ userId, screenEnabled: enabled, screenToggledAt: toggledAt });
  }
}

type TitleInsert = typeof schema.titles.$inferInsert;
type TitleEnrichmentInsert = typeof schema.titleEnrichment.$inferInsert;

/** Inserts one title (defaults: local user, watched movie from 2016) and returns its id. */
export async function insertTitle(
  db: Db,
  values: Partial<TitleInsert> & { title: string }
): Promise<number> {
  const [row] = await db
    .insert(schema.titles)
    .values({ userId: 'local', mediaType: 'movie', status: 'watched', year: 2016, ...values })
    .returning({ id: schema.titles.id });
  return row.id;
}

/**
 * Inserts a title_enrichment row. resolvedAt defaults to BEFORE the seed's last_profiled_at
 * (2026-07-01 12:00), so an enrichment row alone never makes a title "changed" unless a test
 * says so.
 */
export async function insertTitleEnrichment(
  db: Db,
  titleId: number,
  values: Partial<TitleEnrichmentInsert> = {}
): Promise<void> {
  await db.insert(schema.titleEnrichment).values({
    titleId,
    resolutionConfidence: 1,
    confidenceLabel: 'HIGH',
    matchMethod: 'exact',
    identitySource: 'auto',
    resolvedAt: '2026-06-01 00:00:00',
    ...values,
  });
}

export async function setLastProfiledAt(db: Db, at: string, userId = 'local'): Promise<void> {
  await db
    .update(schema.profileMeta)
    .set({ lastProfiledAt: at })
    .where(eq(schema.profileMeta.userId, userId));
}

export interface ScreenLibraryIds {
  arrival: number;
  dune: number;
  severance: number;
  cats: number;
  tenet: number;
  old: number;
  excluded: number;
  otherUsers: number;
}

/**
 * A small screen library covering every eligibility case. No title carries feedback_updated_at,
 * so none counts as "changed" until a test stamps one.
 *   arrival   movie, watched, letterboxd 5, enriched (director, based_on)  -> tier 5
 *   dune      movie, watched, letterboxd 4 / app 4.5, app review           -> tier 4.5
 *   severance tv, watching, app 4, enriched (creator)                      -> tv tier 4
 *   cats      movie, dropped, unrated, letterboxd review                   -> dropped
 *   tenet     movie, want                                                  -> not evidence
 *   old       movie, watched, unrated                                      -> not evidence
 *   excluded  movie, watched, 5, exclude_from_profile                      -> not evidence
 *   otherUsers another tenant's 5-star film                                -> never visible
 */
export async function seedScreenLibrary(db: Db): Promise<ScreenLibraryIds> {
  const arrival = await insertTitle(db, {
    title: 'Arrival',
    year: 2016,
    letterboxdRating: 5,
    lastWatchedOn: '2024-03-01',
  });
  await insertTitleEnrichment(db, arrival, {
    genres: ['science fiction film', 'drama film'],
    directors: ['Denis Villeneuve'],
    basedOn: [{ qid: 'Q7621031', title: 'Story of Your Life', author: 'Ted Chiang' }],
  });
  const dune = await insertTitle(db, {
    title: 'Dune',
    year: 2021,
    letterboxdRating: 4,
    appRating: 4.5,
    appReview: 'Loved the sound.',
    lastWatchedOn: '2023-11-02',
  });
  await insertTitleEnrichment(db, dune, {
    genres: ['science fiction film'],
    directors: ['Denis Villeneuve'],
  });
  const severance = await insertTitle(db, {
    title: 'Severance',
    year: 2022,
    mediaType: 'tv',
    status: 'watching',
    appRating: 4,
  });
  await insertTitleEnrichment(db, severance, {
    genres: ['thriller television series'],
    creators: ['Dan Erickson'],
  });
  const cats = await insertTitle(db, {
    title: 'Cats',
    year: 2019,
    status: 'dropped',
    letterboxdReview: 'Walked out.',
  });
  const tenet = await insertTitle(db, { title: 'Tenet', year: 2020, status: 'want' });
  const old = await insertTitle(db, { title: 'Old', year: 2021 });
  const excluded = await insertTitle(db, {
    title: 'Excluded Film',
    year: 2010,
    letterboxdRating: 5,
    excludeFromProfile: true,
  });
  const otherUsers = await insertTitle(db, {
    userId: 'other',
    title: 'Other Tenant Film',
    year: 2015,
    letterboxdRating: 5,
  });
  return { arrival, dune, severance, cats, tenet, old, excluded, otherUsers };
}

export function toolResponse(name: string, input: Record<string, unknown>): ClaudeMessage {
  return {
    content: [{ type: 'tool_use', name, input }],
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * A Claude stub that simulates the user toggling ScreenSprite WHILE the model is thinking:
 * every create() call re-stamps the user's screen_toggled_at, then returns `response`.
 * Used to prove that a superseded run writes nothing (spec §5.7).
 */
export function toggleFlippingClient(
  db: Db,
  response: ClaudeMessage,
  userId = 'local'
): ClaudeClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    messages: {
      async create(params: Record<string, unknown>) {
        calls.push(params);
        await db
          .update(schema.userSettings)
          .set({ screenToggledAt: '2026-09-01 00:00:00' })
          .where(eq(schema.userSettings.userId, userId));
        return response;
      },
    },
  };
}
