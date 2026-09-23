/**
 * @jest-environment jsdom
 */
import { ApiRequestError, screenApi, SCREEN_REJECT_REASONS, type ScreenCandidate } from '@/lib/api';

jest.mock('@/utils/supabase/client', () => ({
  authEnabled: false,
  getSupabaseClient: () => null,
}));

const fetchMock = jest.fn();

function answer(status: number, body: unknown, raw?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => raw ?? JSON.stringify(body),
  };
}

const candidate: ScreenCandidate = {
  media_type: 'movie',
  title: 'Heat',
  year: 1995,
  wikidata_qid: 'Q614264',
  tvmaze_id: null,
  image_url: null,
  description: null,
  description_source: null,
  description_url: null,
  wikipedia_page: 'Heat (1995 film)',
  genres: ['crime film'],
  directors: ['Michael Mann'],
  creators: [],
  writers: ['Michael Mann'],
  countries: ['United States'],
  original_language: 'en',
  based_on: [],
  main_subjects: [],
  series: [],
  production_companies: [],
  sitelinks: 60,
};

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('screenApi', () => {
  it('encodes the search query and type', async () => {
    fetchMock.mockResolvedValue(answer(200, []));
    await screenApi.search('Amélie & co', 'movie');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/screen/search?q=Am%C3%A9lie+%26+co&type=movie');
    expect(init.method).toBe('GET');
  });

  it('throws ApiRequestError carrying the server detail', async () => {
    fetchMock.mockResolvedValue(
      answer(409, { detail: '"Heat" is already in your ScreenSprite library.' })
    );
    const err = await screenApi
      .addTitle({ candidate, status: 'watched', rating: null, review: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(409);
    expect((err as ApiRequestError).message).toBe(
      '"Heat" is already in your ScreenSprite library.'
    );
  });

  it('falls back to the raw text when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(answer(502, null, 'Bad gateway'));
    const err = (await screenApi.titles().catch((e: unknown) => e)) as ApiRequestError;
    expect(err.status).toBe(502);
    expect(err.detail).toBe('Bad gateway');
  });

  it('names the method and path when the error body is empty', async () => {
    fetchMock.mockResolvedValue(answer(500, null, ''));
    const err = (await screenApi.titles().catch((e: unknown) => e)) as ApiRequestError;
    expect(err.detail).toBe('GET /screen/titles failed (500)');
  });

  it('sends JSON bodies with a content type', async () => {
    fetchMock.mockResolvedValue(answer(200, { run_id: null, served: 0 }));
    await screenApi.recommend('tv');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/screen/recommend');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ media_filter: 'tv' });
  });

  it('uploads the ZIP as multipart with no JSON content type', async () => {
    fetchMock.mockResolvedValue(answer(200, { inserted: 1, updated: 0, unchanged: 0, job: {} }));
    const file = new File(['PK'], 'letterboxd.zip', { type: 'application/zip' });
    await screenApi.importLetterboxd(file);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/screen/import');
    expect(init.body).toBeInstanceOf(FormData);
    expect(((init.body as FormData).get('file') as File).name).toBe('letterboxd.zip');
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('starts enrichment without a limit', async () => {
    fetchMock.mockResolvedValue(answer(200, { job_id: 'j1' }));
    await screenApi.startEnrich();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ force: false, limit: null });
  });

  it('posts feedback to the recommendation', async () => {
    fetchMock.mockResolvedValue(answer(200, { id: 4, status: 'rejected', title: null }));
    await screenApi.recFeedback(4, { status: 'rejected', reject_reasons: ['too_long'] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/screen/recommendations/4/feedback');
    expect(JSON.parse(init.body)).toEqual({ status: 'rejected', reject_reasons: ['too_long'] });
  });

  it('labels exactly the server vocabulary', () => {
    // Mirrors SCREEN_REJECT_REASONS in lib/server/screenRecs.ts (wave 7). Jest cannot import that
    // module (it pulls in the database), so the list is pinned here; change both together.
    expect(Object.keys(SCREEN_REJECT_REASONS)).toEqual([
      'wrong_genre',
      'too_dark',
      'too_long',
      'not_now',
      'overhyped',
      'wrong_vibe',
    ]);
  });
});
