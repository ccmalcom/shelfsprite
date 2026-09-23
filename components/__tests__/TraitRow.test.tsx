/**
 * @jest-environment jsdom
 */
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui';
import { TraitRow } from '@/components/profile/TraitRow';
import type { Trait } from '@/lib/api';

const mockUpdateTrait = jest.fn();
const mockSetTraitVerdict = jest.fn();
const mockMutate = jest.fn();

jest.mock('@/lib/api', () => ({
  api: { updateTrait: (...args: unknown[]) => mockUpdateTrait(...args) },
  setTraitVerdict: (...args: unknown[]) => mockSetTraitVerdict(...args),
  TRAITS_KEY: 'profile-traits',
  PROFILE_STATUS_KEY: 'profile-status',
}));

jest.mock('swr', () => ({
  __esModule: true,
  default: jest.fn(),
  mutate: (...args: unknown[]) => mockMutate(...args),
}));

function makeTrait(overrides: Partial<Trait> = {}): Trait {
  return {
    id: 7,
    claim: 'Rewards dense political world-building over fast plotting',
    reveal_line: null,
    polarity: 'reward',
    exhibits: [1, 2],
    contrasts: [3],
    inference_confidence: 0.82,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '2026-09-01T00:00:00',
    ...overrides,
  };
}

const bookMap = new Map<number, string>([
  [1, 'The Dispossessed'],
  [2, 'A Memory Called Empire'],
  [3, 'Red Rising'],
]);

// A stateful stand-in for TraitsSection, which owns open state in the real app.
function Harness({ trait, startOpen = false }: { trait: Trait; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <ToastProvider>
      <TraitRow trait={trait} bookMap={bookMap} open={open} onToggle={() => setOpen((o) => !o)} />
    </ToastProvider>
  );
}

function header(): HTMLElement {
  return screen.getByRole('button', { name: /Rewards dense political/ });
}

beforeEach(() => {
  mockUpdateTrait.mockReset().mockResolvedValue(makeTrait());
  mockSetTraitVerdict.mockReset();
  mockMutate.mockReset().mockResolvedValue(undefined);
});

describe('TraitRow', () => {
  it('starts collapsed with a native button header that controls a hidden panel', () => {
    const { container } = render(<Harness trait={makeTrait()} />);
    const button = header();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveAttribute('aria-controls', 'trait-panel-7');
    const panel = container.querySelector('#trait-panel-7') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
    expect(screen.queryByRole('button', { name: 'Reword' })).toBeNull();
    expect(container.querySelector('#trait-7')).not.toBeNull();
  });

  it('clamps the claim to two lines when collapsed and shows it in full when open', () => {
    render(<Harness trait={makeTrait()} />);
    const claim = screen.getByText('Rewards dense political world-building over fast plotting');
    expect(claim.className).toContain('line-clamp-2');
    fireEvent.click(header());
    expect(claim.className).not.toContain('line-clamp-2');
  });

  it('toggles open and closed when the claim itself is clicked, without entering edit', () => {
    render(<Harness trait={makeTrait()} />);
    fireEvent.click(screen.getByText('Rewards dense political world-building over fast plotting'));
    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('textbox', { name: 'Edit trait claim' })).toBeNull();
    fireEvent.click(header());
    expect(header()).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows evidence with the e.g. and unlike labels in the open panel', () => {
    render(<Harness trait={makeTrait()} startOpen />);
    expect(screen.getByText('e.g.')).toBeInTheDocument();
    expect(screen.getByText('The Dispossessed')).toBeInTheDocument();
    expect(screen.getByText('A Memory Called Empire')).toBeInTheDocument();
    expect(screen.getByText('unlike')).toBeInTheDocument();
    expect(screen.getByText('Red Rising')).toBeInTheDocument();
  });

  it('shows verdict state on the collapsed row', () => {
    const { container, rerender } = render(
      <Harness trait={makeTrait({ status: 'confirmed', user_weight: 0.5 })} />
    );
    expect(header()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('confirmed')).toBeInTheDocument();
    expect(screen.getByText('0.5x')).toBeInTheDocument();
    expect(screen.getByText('82%')).toBeInTheDocument();

    rerender(<Harness trait={makeTrait({ status: 'rejected' })} />);
    expect(screen.getByText('rejected')).toBeInTheDocument();
    expect((container.querySelector('#trait-7') as HTMLElement).className).toContain('opacity-50');
    expect(
      screen.getByText('Rewards dense political world-building over fast plotting').className
    ).toContain('line-through');

    rerender(<Harness trait={makeTrait({ status: 'edited' })} />);
    expect(screen.getByText('edited')).toBeInTheDocument();

    rerender(<Harness trait={makeTrait({ status: 'proposed', user_weight: 1 })} />);
    expect(screen.queryByText('proposed')).toBeNull();
    expect(screen.queryByText(/x$/)).toBeNull();
  });

  it('marks the aversion polarity as Avoids', () => {
    render(<Harness trait={makeTrait({ polarity: 'aversion', claim: 'Avoids military SF' })} />);
    expect(screen.getByText('Avoids')).toBeInTheDocument();
  });

  it('records a verdict from the panel', async () => {
    const trait = makeTrait();
    mockSetTraitVerdict.mockResolvedValue({ ...trait, status: 'confirmed' });
    render(<Harness trait={trait} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(mockSetTraitVerdict).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ status: 'confirmed' })
      )
    );
    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith('profile-status'));
  });

  it('records Apply less as a 0.5 weight', async () => {
    const trait = makeTrait();
    mockSetTraitVerdict.mockResolvedValue({ ...trait, user_weight: 0.5 });
    render(<Harness trait={trait} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply less' }));
    await waitFor(() =>
      expect(mockSetTraitVerdict).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ user_weight: 0.5 })
      )
    );
  });

  it('rewords through the Reword button and saves', async () => {
    render(<Harness trait={makeTrait()} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    const box = screen.getByRole('textbox', { name: 'Edit trait claim' });
    expect(box).toHaveValue('Rewards dense political world-building over fast plotting');
    fireEvent.change(box, { target: { value: 'Rewards dense political world-building' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockUpdateTrait).toHaveBeenCalledWith(7, {
        claim: 'Rewards dense political world-building',
      })
    );
    await waitFor(() => expect(mockMutate).toHaveBeenCalledWith('profile-traits'));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Edit trait claim' })).toBeNull()
    );
  });

  it('saves with Ctrl+Enter and cancels with Escape', async () => {
    render(<Harness trait={makeTrait()} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    const box = screen.getByRole('textbox', { name: 'Edit trait claim' });
    fireEvent.change(box, { target: { value: 'Something else entirely' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Edit trait claim' })).toBeNull();
    expect(mockUpdateTrait).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    const again = screen.getByRole('textbox', { name: 'Edit trait claim' });
    expect(again).toHaveValue('Rewards dense political world-building over fast plotting');
    fireEvent.change(again, { target: { value: 'Something else entirely' } });
    fireEvent.keyDown(again, { key: 'Enter', ctrlKey: true });
    await waitFor(() =>
      expect(mockUpdateTrait).toHaveBeenCalledWith(7, { claim: 'Something else entirely' })
    );
  });

  it('does not collapse while rewording', () => {
    render(<Harness trait={makeTrait()} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    const box = screen.getByRole('textbox', { name: 'Edit trait claim' });
    fireEvent.change(box, { target: { value: 'Half-typed draft' } });

    fireEvent.click(header());

    expect(header()).toHaveAttribute('aria-expanded', 'true');
    expect(header()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('textbox', { name: 'Edit trait claim' })).toHaveValue(
      'Half-typed draft'
    );
  });

  it('hides verdict buttons while rewording', () => {
    render(<Harness trait={makeTrait()} startOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Reword' }));
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reword' })).toBeNull();
  });
});
