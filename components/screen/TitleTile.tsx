'use client';

import Image from 'next/image';
import { useState } from 'react';
import type { MediaType } from '@/lib/api';
import { mediaLabel } from '@/lib/screen';

interface TitleTileProps {
  title: string;
  year: number | null;
  mediaType: MediaType;
  imageUrl: string | null;
  className?: string;
  sizes?: string;
  /** Load now instead of lazily: set it on tiles that can be the page's LCP element. */
  eager?: boolean;
}

/**
 * A poster, hotlinked (spec §7.8): `unoptimized` means the browser loads straight from
 * upload.wikimedia.org or static.tvmaze.com and ShelfSprite never copies or re-encodes the file.
 * It also bypasses the loader's remotePatterns check, which must stay narrow. A missing or failed
 * image falls back to a typographic tile. The failure is remembered per URL, so a corrected
 * title's new poster gets its own try without an effect.
 */
export default function TitleTile({
  title,
  year,
  mediaType,
  imageUrl,
  className = '',
  sizes = '160px',
  eager = false,
}: TitleTileProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = imageUrl !== null && imageUrl !== '' && failedUrl !== imageUrl;

  return (
    <div
      className={['relative aspect-[2/3] overflow-hidden rounded-lg bg-elevated', className].join(
        ' '
      )}
    >
      {showImage ? (
        <Image
          src={imageUrl}
          alt={`Poster for ${title}`}
          fill
          sizes={sizes}
          loading={eager ? 'eager' : 'lazy'}
          unoptimized
          className="object-cover"
          onError={() => setFailedUrl(imageUrl)}
        />
      ) : (
        <div
          data-testid="title-tile-fallback"
          className="flex h-full flex-col justify-between bg-accent-quiet p-3"
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
            {mediaLabel(mediaType)}
          </span>
          <span className="line-clamp-4 font-display text-lg font-semibold leading-tight text-text">
            {title}
          </span>
          <span className="font-mono text-xs text-muted">{year ?? ''}</span>
        </div>
      )}
    </div>
  );
}
