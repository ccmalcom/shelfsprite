import { mutate } from 'swr';
import { ApiRequestError } from '@/lib/api';
import {
  handleScreenError,
  invalidateScreenState,
  invalidateTitleEdits,
  SCREEN_STATE_KEYS,
} from '@/lib/screenCache';

jest.mock('swr', () => ({ __esModule: true, mutate: jest.fn(() => Promise.resolve()) }));
jest.mock('@/utils/supabase/client', () => ({ authEnabled: false, getSupabaseClient: () => null }));

const mutateMock = mutate as unknown as jest.Mock;

beforeEach(() => mutateMock.mockClear());

describe('invalidateScreenState', () => {
  it('covers traits, archetype, reveal, profile status and every screen key but settings', () => {
    expect([...SCREEN_STATE_KEYS].sort()).toEqual(
      [
        'archetype',
        'profile',
        'profile-status',
        'profile-traits',
        'reveal-books',
        'reveal-highlights',
        'reveal-stats',
        'reveal-titles',
        'reveal-traits',
        'screen-enrich-active',
        'screen-recommendations',
        'screen-titles',
      ].sort()
    );
  });

  it('uses the three-argument form for every key', async () => {
    await invalidateScreenState();
    expect(mutateMock).toHaveBeenCalledTimes(SCREEN_STATE_KEYS.length);
    for (const call of mutateMock.mock.calls) {
      expect(call[1]).toBeUndefined();
      expect(call[2]).toEqual({ revalidate: true });
    }
  });
});

describe('invalidateTitleEdits', () => {
  it('revalidates titles and profile status and clears the reveal titles', async () => {
    await invalidateTitleEdits();
    const keys = mutateMock.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(['screen-titles', 'profile-status', 'reveal-titles']);
    expect(mutateMock.mock.calls[2]).toEqual(['reveal-titles', undefined, { revalidate: true }]);
  });
});

describe('handleScreenError', () => {
  it('re-reads the settings on a 403', () => {
    handleScreenError(new ApiRequestError(403, 'ScreenSprite is not enabled for this account.'));
    expect(mutateMock).toHaveBeenCalledWith('screen-settings');
  });
  it('ignores other failures', () => {
    handleScreenError(new ApiRequestError(500, 'boom'));
    handleScreenError(new Error('network'));
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
