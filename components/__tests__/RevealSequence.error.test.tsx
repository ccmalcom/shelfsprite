/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import RevealSequence from '@/components/reveal/RevealSequence';

// Every reveal input is still loading except the traits, which failed.
jest.mock('swr', () => ({
  __esModule: true,
  default: (key: unknown) =>
    key === 'reveal-traits'
      ? { data: undefined, error: new Error('No taste profile found') }
      : { data: undefined, error: undefined },
}));

jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

jest.mock('@/lib/api', () => ({
  api: {},
  screenApi: {},
  getDirective: jest.fn(),
  ARCHETYPE_KEY: 'archetype',
  DIRECTIVE_KEY: 'directive',
  REVEAL_TITLES_KEY: 'reveal-titles',
  SCREEN_SETTINGS_KEY: 'screen-settings',
}));

describe('reveal error state', () => {
  it('sends "See it here" to the profile when the caller says where that is', () => {
    const onClose = jest.fn();
    const onSeeProfile = jest.fn();
    render(<RevealSequence onClose={onClose} onFinish={jest.fn()} onSeeProfile={onSeeProfile} />);
    expect(screen.getByText('The reveal tripped on something.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See it here' }));
    expect(onSeeProfile).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes the reveal when it was opened from the profile itself', () => {
    const onClose = jest.fn();
    render(<RevealSequence onClose={onClose} onFinish={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'See it here' }));
    expect(onClose).toHaveBeenCalled();
  });
});
