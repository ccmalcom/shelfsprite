/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui';
import { RewardTraitBeat, AversionsBeat } from '@/components/reveal/TraitBeats';
import { renderBeat } from '@/components/reveal/RevealSequence';
import type { Beat } from '@/lib/revealBeats';
import type { Trait } from '@/lib/api';

const mockSetTraitVerdict = jest.fn();
const mockUpdateTrait = jest.fn();

jest.mock('@/lib/api', () => ({
  setTraitVerdict: (...args: unknown[]) => mockSetTraitVerdict(...args),
  api: { updateTrait: (...args: unknown[]) => mockUpdateTrait(...args) },
}));

function trait(over: Partial<Trait> = {}): Trait {
  return {
    id: 7,
    claim: 'These reliably reach 4.5.',
    reveal_line: 'You love a slow-burn mystery.',
    polarity: 'reward',
    exhibits: [1],
    contrasts: [2],
    inference_confidence: 0.8,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '',
    ...over,
  };
}

function rewardBeat(over: Partial<Extract<Beat, { kind: 'reward-trait' }>> = {}) {
  return {
    kind: 'reward-trait' as const,
    trait: trait(),
    lowConfidence: false,
    exhibitTitles: ['Tana French'],
    contrastTitles: ['Say Nothing'],
    contrastRelation: null,
    ...over,
  };
}

function renderReward(beat = rewardBeat()) {
  return render(
    <ToastProvider>
      <RewardTraitBeat beat={beat} onNext={jest.fn()} onVerdict={jest.fn()} />
    </ToastProvider>
  );
}

beforeEach(() => {
  mockSetTraitVerdict.mockReset().mockResolvedValue({});
  mockUpdateTrait.mockReset().mockResolvedValue({});
});

describe('reward trait beat', () => {
  it('words the contrast by how the book was actually rated', () => {
    const { rerender } = renderReward(rewardBeat({ contrastRelation: 'lower' }));
    expect(screen.getByText('(Rated lower: “Say Nothing”.)')).toBeInTheDocument();
    rerender(
      <ToastProvider>
        <RewardTraitBeat
          beat={rewardBeat({ contrastRelation: 'same' })}
          onNext={jest.fn()}
          onVerdict={jest.fn()}
        />
      </ToastProvider>
    );
    expect(screen.getByText('(For contrast: “Say Nothing”.)')).toBeInTheDocument();
    expect(screen.queryByText(/didn.t land/)).toBeNull();
  });

  it('labels the delete path plainly and keeps Almost as the partial one', () => {
    renderReward();
    expect(screen.getByRole('button', { name: 'Not me' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not quite' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Almost…' })).toBeInTheDocument();
  });

  it('starts the Almost editor from the sentence the reader just read', () => {
    renderReward();
    fireEvent.click(screen.getByRole('button', { name: 'Almost…' }));
    expect(screen.getByLabelText('Rewrite this trait in your own words')).toHaveValue(
      'You love a slow-burn mystery.'
    );
  });
});

describe('aversions beat', () => {
  const beat: Extract<Beat, { kind: 'aversions' }> = {
    kind: 'aversions',
    items: [
      { trait: trait({ id: 1, polarity: 'aversion' }), evidence: 'Case in point: “Dune”.' },
      { trait: trait({ id: 2, polarity: 'aversion' }), evidence: '' },
    ],
  };

  it('shows no answer as chosen until the reader picks one', async () => {
    render(
      <ToastProvider>
        <AversionsBeat beat={beat} onNext={jest.fn()} onVerdict={jest.fn()} />
      </ToastProvider>
    );
    const trues = screen.getAllByRole('button', { name: 'True' });
    for (const b of trues) expect(b.className).not.toContain('bg-user');
    expect(screen.getByText('Case in point: “Dune”.')).toBeInTheDocument();

    fireEvent.click(trues[0]);
    await waitFor(() => expect(trues[0]).toHaveAttribute('aria-pressed', 'true'));
    expect(trues[0].className).toContain('bg-user');
    expect(trues[1].className).not.toContain('bg-user');
  });
});

describe('axis beat', () => {
  it('shows a readable axis label and no scoring notes', () => {
    const handlers = {
      next: jest.fn(),
      onFinish: jest.fn(),
      onClose: jest.fn(),
      onVerdict: jest.fn(),
      verdicts: {},
    };
    render(
      <>
        {renderBeat(
          {
            kind: 'axis',
            axisKey: 'lens',
            letter: 'R',
            poleLine: 'You read to think.',
            label: 'Why you read',
            question: 'To be carried somewhere else, or to think something through?',
            nearCenter: false,
            codeSoFar: 'R',
          },
          handlers
        )}
      </>
    );
    expect(screen.getByRole('heading', { name: 'Why you read' })).toBeInTheDocument();
    expect(screen.queryByText(/lens\./i)).toBeNull();
  });
});
