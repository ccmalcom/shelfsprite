/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import ReaderSprite from '@/components/ReaderSprite';

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

describe('ReaderSprite', () => {
  it('renders the sprite for a known code', () => {
    const { container } = render(<ReaderSprite code="IPBM" size={180} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', '/reader-types/ipbm-plot-mechanic.webp');
  });

  // The adjacent copy always names the archetype, so announcing the image would
  // just repeat it -- same rule as components/ShelfSprite.tsx.
  it('is decorative', () => {
    const { container } = render(<ReaderSprite code="IPBM" size={180} />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('alt', '');
    expect(img).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders nothing for an unknown code', () => {
    const { container } = render(<ReaderSprite code="XXXX" size={180} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders nothing when no code has been derived yet', () => {
    const { container } = render(<ReaderSprite code={null} size={180} />);
    expect(container.querySelector('img')).toBeNull();
  });

  it('passes the caller class through', () => {
    const { container } = render(<ReaderSprite code="IPBM" size={96} className="mx-auto" />);
    expect(container.querySelector('img')!.className).toContain('mx-auto');
  });
});
