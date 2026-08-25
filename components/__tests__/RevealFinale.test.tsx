/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import { renderBeat } from '@/components/reveal/RevealSequence';
import type { Beat } from '@/lib/revealBeats';

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

const handlers = {
  next: jest.fn(),
  onFinish: jest.fn(),
  onClose: jest.fn(),
  onVerdict: jest.fn(),
  verdicts: {},
};

function finaleBeat(code: string): Beat {
  return {
    kind: 'finale',
    thin: false,
    nBooks: 214,
    archetype: {
      code,
      name: 'The Devoted Fan',
      tagline: 'I live in this world now.',
      hook: 'reread the whole series to get ready for the new one',
      derived_at: '2026-01-01T00:00:00Z',
      is_stale: false,
      lens: { score: -0.6, rationale: 'r', letter: 'I' },
      engine: { score: -0.4, rationale: 'r', letter: 'C' },
      range: { score: 0.5, rationale: 'r', letter: 'D' },
      resonance: { score: -0.3, rationale: 'r', letter: 'H' },
    },
  };
}

describe('reveal finale', () => {
  it('lands the reader-type sprite on the payoff beat', () => {
    const { container } = render(<>{renderBeat(finaleBeat('ICDH'), handlers)}</>);
    expect(container.querySelector('img[src="/reader-types/icdh-devoted-fan.webp"]')).not.toBeNull();
  });

  it('still renders the finale text when the code has no sprite', () => {
    const { container, getByText } = render(<>{renderBeat(finaleBeat('XXXX'), handlers)}</>);
    expect(container.querySelector('img[src^="/reader-types/"]')).toBeNull();
    expect(getByText('The Devoted Fan')).toBeInTheDocument();
  });
});
