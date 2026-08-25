/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import { ArchetypeShareModal } from '@/components/ArchetypeShareModal';
import { ToastProvider } from '@/components/ui';

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

const archetype = {
  code: 'RPBH',
  name: 'The Conscious Adventurer',
  tagline: 'Beautiful prose AND a great story.',
  hook: 'refuses to choose between a page-turner and a poem',
  derived_at: '2026-01-01T00:00:00Z',
  is_stale: false,
  lens: { score: 0.6, rationale: 'r', letter: 'R' },
  engine: { score: -0.4, rationale: 'r', letter: 'P' },
  range: { score: -0.5, rationale: 'r', letter: 'B' },
  resonance: { score: -0.3, rationale: 'r', letter: 'H' },
};

function renderModal(code = archetype.code) {
  return render(
    <ToastProvider>
      <ArchetypeShareModal archetype={{ ...archetype, code } as never} onClose={jest.fn()} />
    </ToastProvider>
  );
}

describe('ArchetypeShareModal', () => {
  it('puts the sprite on the share card preview', () => {
    const { container } = renderModal();
    expect(
      container.querySelector('img[src="/reader-types/rpbh-conscious-adventurer.webp"]')
    ).not.toBeNull();
  });

  it('still renders the card when the code has no sprite', () => {
    const { container, getByText } = renderModal('XXXX');
    expect(container.querySelector('img[src^="/reader-types/"]')).toBeNull();
    expect(getByText('The Conscious Adventurer')).toBeInTheDocument();
  });
});
