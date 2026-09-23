/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '@/components/ui';
import { TraitRow, type TitleEvidence } from '@/components/profile/TraitRow';
import type { Trait } from '@/lib/api';

jest.mock('@/lib/api', () => ({
  api: { updateTrait: jest.fn() },
  setTraitVerdict: jest.fn(),
  TRAITS_KEY: 'profile-traits',
  PROFILE_STATUS_KEY: 'profile-status',
}));
jest.mock('swr', () => ({ __esModule: true, default: jest.fn(), mutate: jest.fn() }));

function makeTrait(overrides: Partial<Trait> = {}): Trait {
  return {
    id: 7,
    claim: 'Rewards patient, procedural tension',
    reveal_line: null,
    polarity: 'reward',
    exhibits: [1],
    contrasts: [],
    exhibit_title_ids: [11, 12],
    contrast_title_ids: [13],
    inference_confidence: 0.8,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '2026-09-01T00:00:00',
    ...overrides,
  };
}

const bookMap = new Map<number, string>([
  [1, 'The Dispossessed'],
  [2, 'Piranesi'],
  [3, 'Kindred'],
  [4, 'Beloved'],
]);

const titles = new Map<number, TitleEvidence>([
  [11, { id: 11, title: 'Heat', year: 1995, media_type: 'movie' }],
  [12, { id: 12, title: 'Severance', year: 2022, media_type: 'tv' }],
]);

function renderRow(trait: Trait, titleEvidence?: Map<number, TitleEvidence>) {
  render(
    <ToastProvider>
      <TraitRow
        trait={trait}
        bookMap={bookMap}
        open
        onToggle={jest.fn()}
        titleEvidence={titleEvidence}
      />
    </ToastProvider>
  );
}

describe('TraitRow title evidence', () => {
  it('renders cited films and shows after the books, with a marker', () => {
    renderRow(makeTrait(), titles);
    expect(screen.getByText('The Dispossessed')).toBeInTheDocument();
    expect(screen.getByText('Heat (1995)')).toBeInTheDocument();
    expect(screen.getByText('Severance (2022)')).toBeInTheDocument();
    expect(screen.getByText('Film:')).toHaveClass('sr-only');
    expect(screen.getByText('TV:')).toHaveClass('sr-only');
  });

  it('skips a title no longer in the map', () => {
    renderRow(makeTrait(), titles);
    // 13 is the only contrast and it is not in the map, so there is no "unlike" row at all.
    expect(screen.queryByText('unlike')).toBeNull();
  });

  it('stays book-only without the map', () => {
    renderRow(makeTrait());
    expect(screen.getByText('The Dispossessed')).toBeInTheDocument();
    expect(screen.queryByText('Heat (1995)')).toBeNull();
  });

  it('lets books fill the cap first', () => {
    renderRow(makeTrait({ exhibits: [1, 2, 3, 4] }), titles);
    expect(screen.getByText('Beloved')).toBeInTheDocument();
    expect(screen.queryByText('Heat (1995)')).toBeNull();
  });

  it('renders a title-only trait', () => {
    renderRow(makeTrait({ exhibits: [], exhibit_title_ids: [12] }), titles);
    expect(screen.getByText('e.g.')).toBeInTheDocument();
    expect(screen.getByText('Severance (2022)')).toBeInTheDocument();
  });
});
