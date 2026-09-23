import Image from 'next/image';
import BrandLogo from '@/components/BrandLogo';
import type { Section } from '@/lib/nav';

/**
 * The rail and mobile-header wordmark (spec §7.11). In the screen section it is the existing
 * mark plus a "ScreenSprite" text wordmark; a ScreenSprite logo is a follow-up (§12).
 * `compact` narrows the ShelfSprite logo on phones while the section switch shares the header.
 */
export default function Wordmark({
  section,
  compact = false,
}: {
  section: Section;
  compact?: boolean;
}) {
  if (section === 'screen') {
    return (
      <span className="flex items-center gap-2">
        <Image
          src="/icon.svg"
          alt=""
          width={28}
          height={28}
          priority
          unoptimized
          className="h-7 w-7 rounded-md"
        />
        <span className="font-display text-[17px] font-bold tracking-tight text-text lg:text-xl">
          ScreenSprite
        </span>
      </span>
    );
  }
  return (
    <BrandLogo
      alt=""
      priority
      sizes="170px"
      className={['h-auto lg:w-[170px]', compact ? 'w-[112px]' : 'w-[150px]'].join(' ')}
    />
  );
}
