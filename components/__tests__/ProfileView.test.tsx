/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { ProfileView } from '@/components/profile/ProfileView';
import { ToastProvider } from '@/components/ui';
import type { Trait } from '@/lib/api';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

const heroProps: Record<string, unknown>[] = [];
jest.mock('@/components/TasteHero', () => ({
  TasteHero: (props: Record<string, unknown>) => {
    heroProps.push(props);
    return <div />;
  },
}));
jest.mock('@/components/CustomInstructions', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('@/components/ShelfSprite', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('@/components/reveal/RevealSequence', () => ({ __esModule: true, default: () => null }));
jest.mock('@/hooks/useFeedbackPrompt', () => ({
  useFeedbackPrompt: () => ({ fire: jest.fn(), modal: null }),
}));
jest.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

const trait: Trait = {
  id: 7,
  claim: 'Rewards patient, procedural tension',
  reveal_line: null,
  polarity: 'reward',
  exhibits: [],
  contrasts: [],
  exhibit_title_ids: [11],
  contrast_title_ids: [],
  inference_confidence: 0.8,
  status: 'proposed',
  user_weight: 1,
  user_note: null,
  created_at: '2026-09-01T00:00:00',
};

let screenEnabled = true;
let titlesData: unknown = [makeTitle({ id: 11, title: 'Heat', year: 1995 })];
let titlesError: Error | undefined;
const requested: (string | null)[] = [];

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | null) => {
    requested.push(key);
    const data: Record<string, unknown> = {
      'screen-settings': { enabled: screenEnabled, toggled_at: null, title_count: 1 },
      'screen-titles': titlesData,
      'profile-traits': [trait],
      stats: { total: 3, rated: 2, unrated: 1, shelves: {}, mean_rating: 4, by_star: { '4': 2 } },
      'profile-subjects': { overall: [{ subject: 'Gothic Fiction', count: 2 }], by_tier: {} },
    };
    return {
      data: key === null ? undefined : data[key],
      error: key === 'screen-titles' ? titlesError : undefined,
      isLoading: false,
      mutate: jest.fn(),
    };
  },
  mutate: jest.fn(),
}));

function renderView(section: 'books' | 'screen' = 'books') {
  render(
    <ToastProvider>
      <ProfileView section={section} />
    </ToastProvider>
  );
}

beforeEach(() => {
  requested.length = 0;
  heroProps.length = 0;
  titlesData = [makeTitle({ id: 11, title: 'Heat', year: 1995 })];
  titlesError = undefined;
});

describe('ProfileView', () => {
  it('passes title evidence while ScreenSprite is on', () => {
    screenEnabled = true;
    renderView();
    expect(screen.getByText('Heat (1995)')).toBeInTheDocument();
    expect(screen.getByText(/What your books, films and shows have in common/)).toBeInTheDocument();
  });

  it('stays book-only and fetches no titles while it is off', () => {
    screenEnabled = false;
    renderView();
    expect(screen.queryByText('Heat (1995)')).toBeNull();
    expect(requested).not.toContain('screen-titles');
    expect(screen.getByText(/What your books have in common/)).toBeInTheDocument();
  });

  it('shows book stats in the books section', () => {
    screenEnabled = true;
    renderView('books');
    expect(screen.getByText('Gothic Fiction')).toBeInTheDocument();
    expect(screen.getByText(/2 rated books/)).toBeInTheDocument();
    expect(screen.queryByText('Your screen library')).toBeNull();
  });

  it('shows screen stats and never requests book stats in the screen section', () => {
    screenEnabled = true;
    renderView('screen');
    expect(requested).not.toContain('stats');
    expect(requested).not.toContain('profile-subjects');
    expect(screen.queryByText('Gothic Fiction')).toBeNull();
    expect(screen.getByText('Your screen library')).toBeInTheDocument();
    expect(screen.getByText(/1 rated title\b/)).toBeInTheDocument();
    expect(screen.getByText('Crime')).toBeInTheDocument();
    // TasteHero fetches its own subjects; the screen section turns that off too.
    expect(heroProps.at(-1)).toMatchObject({ bookSubjects: false });
  });

  it('lets the books section hero load book subjects', () => {
    renderView('books');
    expect(heroProps.at(-1)).toMatchObject({ bookSubjects: true });
  });

  it('says so, with a retry, when the titles fail to load', () => {
    screenEnabled = true;
    titlesData = undefined;
    titlesError = new Error('boom');
    renderView('screen');
    expect(screen.getByRole('alert')).toHaveTextContent(/films and shows didn.t load/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
