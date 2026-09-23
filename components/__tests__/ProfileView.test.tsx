/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { ProfileView } from '@/components/profile/ProfileView';
import { ToastProvider } from '@/components/ui';
import type { Trait } from '@/lib/api';
import { makeTitle } from '@/lib/__tests__/fixtures/screenFixtures';

jest.mock('@/components/TasteHero', () => ({ TasteHero: () => <div /> }));
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
const requested: (string | null)[] = [];

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string | null) => {
    requested.push(key);
    const data: Record<string, unknown> = {
      'screen-settings': { enabled: screenEnabled, toggled_at: null, title_count: 1 },
      'screen-titles': [makeTitle({ id: 11, title: 'Heat', year: 1995 })],
      'profile-traits': [trait],
    };
    return {
      data: key === null ? undefined : data[key],
      error: undefined,
      isLoading: false,
      mutate: jest.fn(),
    };
  },
  mutate: jest.fn(),
}));

function renderView() {
  render(
    <ToastProvider>
      <ProfileView />
    </ToastProvider>
  );
}

beforeEach(() => {
  requested.length = 0;
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
});
