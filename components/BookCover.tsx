'use client';
import { useState } from 'react';
import Image from 'next/image';
import { BookOpen } from 'lucide-react';

export default function BookCover({
  book,
  className = 'h-20 w-14',
}: {
  book: { title?: string; cover_url?: string | null };
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = book.cover_url;
  return (
    <div className={`relative shrink-0 overflow-hidden rounded bg-elevated shadow-sm ${className}`}>
      {src && failed !== src ? (
        <Image
          src={src}
          alt={`Cover of ${book.title ?? 'book'}`}
          fill
          unoptimized
          className="object-cover"
          onError={() => setFailed(src)}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-faint">
          <BookOpen size={24} aria-hidden="true" />
          <span className="sr-only">No cover available</span>
        </div>
      )}
    </div>
  );
}
