/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CustomInstructions from '@/components/CustomInstructions';
import { DIRECTIVE_KEY, DIRECTIVE_SUGGESTIONS_KEY } from '@/lib/api';

const mockPut = jest.fn();
const mockDelete = jest.fn();
const mockMutate = jest.fn();
let mockDirective: Record<string, unknown> = { nl_text: null, constraints: {}, updated_at: null };
const mockSuggestions = {
  authors: [{ value: 'Gene Wolfe', count: 4 }],
  subjects: [{ value: 'space opera', count: 7 }],
};

jest.mock('swr', () => ({
  __esModule: true,
  default: (key: string) => ({
    data: key === 'directive-suggestions' ? mockSuggestions : mockDirective,
  }),
  useSWRConfig: () => ({ mutate: (...args: unknown[]) => mockMutate(...args) }),
}));

// requireActual keeps the real DIRECTIVE_KEY / DIRECTIVE_SUGGESTIONS_KEY /
// MAX_PREFER_ENTRIES constants, so the assertions below compare against the real
// values rather than restating them. The swr mock above cannot reference them (jest
// hoists jest.mock factories above the imports), hence the literal there.
jest.mock('@/lib/api', () => {
  const actual = jest.requireActual('@/lib/api');
  return {
    ...actual,
    getDirective: jest.fn(),
    getPreferenceSuggestions: jest.fn(),
    deleteDirective: (...args: unknown[]) => mockDelete(...args),
    putDirective: (...args: unknown[]) => mockPut(...args),
  };
});

// DirectiveChat opens a Claude-backed modal; the modal itself is not under test, but
// its onApply contract is -- so the stub exposes a button that applies a fixed draft.
// It only mounts once "Help me write this" is clicked, so tests that never open it are
// unaffected.
jest.mock('@/components/DirectiveChat', () => ({
  __esModule: true,
  default: ({
    onApply,
  }: {
    onApply: (text: string, constraints: Record<string, unknown>) => void;
  }) => (
    <button onClick={() => onApply('Distilled prose.', { exclude_subjects: ['grimdark'] })}>
      apply-draft
    </button>
  ),
}));

beforeEach(() => {
  mockPut.mockReset().mockResolvedValue({});
  mockDelete.mockReset().mockResolvedValue({});
  mockMutate.mockReset().mockResolvedValue(undefined);
  mockDirective = { nl_text: null, constraints: {}, updated_at: null };
});

it('sends prose and favorites in one PUT', async () => {
  mockDirective = { nl_text: 'No grimdark.', constraints: {}, updated_at: null };
  render(<CustomInstructions />);

  fireEvent.click(screen.getByRole('button', { name: 'Add Gene Wolfe' }));
  fireEvent.change(screen.getByLabelText('Favorite genres & subjects'), {
    target: { value: 'translated fiction' },
  });
  fireEvent.keyDown(screen.getByLabelText('Favorite genres & subjects'), { key: 'Enter' });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
  expect(mockPut).toHaveBeenCalledWith({
    nl_text: 'No grimdark.',
    constraints: {
      prefer_authors: ['Gene Wolfe'],
      prefer_subjects: ['translated fiction'],
    },
  });
});

it('deletes the record instead of PUTting an empty one when the last favorite goes', async () => {
  // PUT /directive 422s on a record whose text and cleaned constraints are both
  // empty, and save() has no catch — so without this the reader silently loses the
  // action. Removing your last favorite is a normal thing to do.
  mockDirective = {
    nl_text: null,
    constraints: { prefer_authors: ['Gene Wolfe'] },
    updated_at: null,
  };
  render(<CustomInstructions />);
  fireEvent.click(screen.getByRole('button', { name: 'Remove Gene Wolfe' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
  expect(mockPut).not.toHaveBeenCalled();
});

it('revalidates the suggestions key after saving, so the row is replenished', async () => {
  mockDirective = { nl_text: 'No grimdark.', constraints: {}, updated_at: null };
  render(<CustomInstructions />);
  fireEvent.click(screen.getByRole('button', { name: 'Add Gene Wolfe' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mockMutate).toHaveBeenCalledWith(DIRECTIVE_SUGGESTIONS_KEY));
  expect(mockMutate).toHaveBeenCalledWith(DIRECTIVE_KEY);
});

it('shows the Clear button for a constraints-only record', () => {
  // Today the Clear button is gated on nl_text alone, so this reader cannot clear
  // their record at all — and favorites make the state reachable for the first time.
  mockDirective = {
    nl_text: null,
    constraints: { prefer_authors: ['Gene Wolfe'] },
    updated_at: null,
  };
  render(<CustomInstructions />);
  expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
});

it('hides the Clear button for a genuinely empty record', () => {
  render(<CustomInstructions />);
  expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
});

// DISTILL_TOOL declares only the hard filters, so a draft never carries prefer_*.
// Replacing constraints wholesale silently discarded the reader's favorites.
it('keeps favorites when a chat draft is applied', async () => {
  mockDirective = {
    nl_text: 'Old prose.',
    constraints: { prefer_authors: ['Gene Wolfe'], prefer_subjects: ['space opera'] },
    updated_at: null,
  };
  render(<CustomInstructions />);

  fireEvent.click(screen.getByRole('button', { name: 'Help me write this' }));
  fireEvent.click(screen.getByRole('button', { name: 'apply-draft' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
  expect(mockPut).toHaveBeenCalledWith({
    nl_text: 'Distilled prose.',
    constraints: {
      exclude_subjects: ['grimdark'],
      prefer_authors: ['Gene Wolfe'],
      prefer_subjects: ['space opera'],
    },
  });
});

describe('while the directive record is still loading', () => {
  // useSWR gives `undefined` during the first request, which the component's fallbacks
  // render as an empty record -- indistinguishable from "this reader has no directive".
  beforeEach(() => {
    mockDirective = undefined as unknown as Record<string, unknown>;
  });

  it('disables every editing control', () => {
    render(<CustomInstructions />);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Help me write this' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByLabelText('Favorite authors') as HTMLInputElement).disabled).toBe(true);
  });

  // The destructive half: Save with everything still blank used to take the delete path
  // and erase a directive that does exist, on nothing worse than a slow first paint.
  it('never issues a DELETE', async () => {
    render(<CustomInstructions />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mockMutate).not.toHaveBeenCalled());
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockPut).not.toHaveBeenCalled();
  });
});
