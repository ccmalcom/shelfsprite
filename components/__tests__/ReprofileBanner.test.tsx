/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReprofileBanner from '@/components/ReprofileBanner';

const mockUpdateProfile = jest.fn();
let mockStatus: { dirty: boolean } = { dirty: true };

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: mockStatus, mutate: jest.fn() }),
}));

jest.mock('@/lib/api', () => ({
  api: {
    updateProfile: (...args: unknown[]) => mockUpdateProfile(...args),
    profileStatus: jest.fn(),
  },
  PROFILE_STATUS_KEY: '/profile/status',
}));

const noChanges = { added: [], dropped: [], reworded: [], unchanged: 4 };

beforeEach(() => {
  mockStatus = { dirty: true };
  mockUpdateProfile.mockReset();
});

it('shows the added, dropped and reworded traits after a refresh', async () => {
  mockUpdateProfile.mockResolvedValue({
    mode: 'update',
    changes: {
      added: ['Rewards novellas'],
      dropped: ['Avoids translated fiction'],
      reworded: [{ from: 'Avoids military SF', to: "Avoids military SF unless it's satirical" }],
      unchanged: 9,
    },
  });

  render(<ReprofileBanner />);
  fireEvent.click(screen.getByRole('button', { name: /update profile/i }));

  expect(await screen.findByText('Rewards novellas')).toBeInTheDocument();
  expect(screen.getByText('Avoids translated fiction')).toBeInTheDocument();
  expect(screen.getByText("Avoids military SF unless it's satirical")).toBeInTheDocument();
  expect(screen.getByText(/9 unchanged/i)).toBeInTheDocument();
});

it('keeps the summary visible after the dirty flag clears', async () => {
  mockUpdateProfile.mockResolvedValue({ mode: 'update', changes: { ...noChanges, added: ['X'] } });

  const { rerender } = render(<ReprofileBanner />);
  fireEvent.click(screen.getByRole('button', { name: /update profile/i }));
  expect(await screen.findByText('X')).toBeInTheDocument();

  // The refresh clears status.dirty; the summary must survive the re-render.
  mockStatus = { dirty: false };
  rerender(<ReprofileBanner />);
  expect(screen.getByText('X')).toBeInTheDocument();
});

it('says so plainly when nothing changed', async () => {
  mockUpdateProfile.mockResolvedValue({ mode: 'update', changes: noChanges });

  render(<ReprofileBanner />);
  fireEvent.click(screen.getByRole('button', { name: /update profile/i }));

  expect(await screen.findByText(/no changes/i)).toBeInTheDocument();
});

it('dismisses the summary', async () => {
  mockUpdateProfile.mockResolvedValue({ mode: 'update', changes: { ...noChanges, added: ['X'] } });

  render(<ReprofileBanner />);
  fireEvent.click(screen.getByRole('button', { name: /update profile/i }));
  expect(await screen.findByText('X')).toBeInTheDocument();

  mockStatus = { dirty: false };
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  await waitFor(() => expect(screen.queryByText('X')).not.toBeInTheDocument());
});
