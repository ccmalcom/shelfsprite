import Image from 'next/image';
import { readerSprite } from '@/lib/readerSprites';

interface ReaderSpriteProps {
  /** Four-letter archetype code. Anything unrecognised renders nothing. */
  code: string | null | undefined;
  /** Rendered size in px. Sources are square, 512x512. */
  size: number;
  className?: string;
  priority?: boolean;
}

/**
 * Reader-type illustration. Decorative by the same rule as ShelfSprite: every
 * placement sits beside the archetype's code or name, so announcing the image
 * would only repeat the adjacent text.
 *
 * Returning null for an unknown code is what keeps accounts that pre-date the
 * archetype feature -- and any future code this artwork doesn't cover -- on the
 * text-only layout instead of showing a broken image.
 */
export default function ReaderSprite({
  code,
  size,
  className = '',
  priority = false,
}: ReaderSpriteProps) {
  const sprite = readerSprite(code);
  if (!sprite) return null;

  return (
    <Image
      src={sprite.src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      priority={priority}
      sizes={`${size}px`}
      className={className}
    />
  );
}
