/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProfileStep } from '@/components/SetupWizard';

const mockRunProfile = jest.fn();

jest.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: undefined, mutate: jest.fn() }),
  mutate: jest.fn(async () => undefined),
}));

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

jest.mock('@/lib/api', () => ({
  api: {
    runProfile: (...args: unknown[]) => mockRunProfile(...args),
    profile: jest.fn(async () => []),
    profileStatus: jest.fn(async () => ({ dirty: false })),
  },
  API_KEY_STATUS_KEY: '/settings/api-key',
  PROFILE_STATUS_KEY: '/profile/status',
  USER_PROFILE_KEY: '/me',
}));

beforeEach(() => mockRunProfile.mockReset());

describe('setup profile step', () => {
  it('moves on once the build saved traits', async () => {
    mockRunProfile.mockResolvedValue({ mode: 'full', traits_saved: 7 });
    const onDone = jest.fn();
    render(<ProfileStep onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Build my profile' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('treats a build that saved no traits as a failure and stays on the step', async () => {
    mockRunProfile.mockResolvedValue({ mode: 'full', traits_saved: 0 });
    const onDone = jest.fn();
    render(<ProfileStep onDone={onDone} />);
    fireEvent.click(screen.getByRole('button', { name: 'Build my profile' }));
    expect(await screen.findByText(/didn't find any taste traits/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Build my profile' })).toBeEnabled();
  });
});
