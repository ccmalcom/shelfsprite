'use client';

import { useRef } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui';
import { type ArchetypeOut } from '@/lib/api';
import { tasteAccent } from '@/lib/tasteAccent';
import ReaderSprite from '@/components/ReaderSprite';
import { readerSprite } from '@/lib/readerSprites';

const AXIS_LABELS = [
  { left: 'Immersive', right: 'Reflective' },
  { left: 'Plot-first', right: 'Character-first' },
  { left: 'Broad', right: 'Deep' },
  { left: 'Heart', right: 'Mind' },
];

interface Props {
  archetype: ArchetypeOut;
  onClose: () => void;
}

export function ArchetypeShareModal({ archetype, onClose }: Props) {
  const toast = useToast();
  const titleId = 'archetype-share-title';
  const cardRef = useRef<HTMLDivElement>(null);

  // Small accent text plus a low-opacity wash on a dark card: the vivid role,
  // not the drenched panel surface.
  const accentColor = tasteAccent(archetype.code).vivid;

  // Axis label pairs for the small row below the code
  const axisPairs = AXIS_LABELS.map((a, i) => {
    const letters = [archetype.lens, archetype.engine, archetype.range, archetype.resonance];
    const letter = letters[i]!.letter;
    const label = letter === a.left[0] ? a.left : a.right;
    return label;
  }).join('  |  ');

  async function handleCopyImage() {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 560;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      toast.error('Canvas not supported in this browser');
      return;
    }

    // A sprite that won't decode must not cost the user their share image, so a
    // failure here falls through to the original text-only layout below.
    let spriteImg: HTMLImageElement | null = null;
    const sprite = readerSprite(archetype.code);
    if (sprite) {
      try {
        const img = new window.Image();
        img.src = sprite.src;
        await img.decode();
        spriteImg = img;
      } catch {
        spriteImg = null;
      }
    }

    // Background
    ctx.fillStyle = '#1e1b18';
    ctx.fillRect(0, 0, 800, 560);

    // Accent wash (top strip) — archetype color at low opacity
    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = accentColor;
    ctx.fillRect(0, 0, 800, 120);
    ctx.restore();

    // Wordmark
    ctx.fillStyle = '#a3a09d';
    ctx.font = '500 22px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('ShelfSprite', 56, 68);

    // 800x560 canvas. The sprite sits centered under the accent wash; every text
    // baseline below shifts down to make room, and reverts to today's geometry
    // when there is no sprite to draw.
    if (spriteImg) ctx.drawImage(spriteImg, 320, 80, 160, 160);

    const codeSize = spriteImg ? 80 : 96;
    const codeY = spriteImg ? 320 : 230;
    const nameY = spriteImg ? 372 : 300;
    const taglineY = spriteImg ? 414 : 350;
    const axisY = spriteImg ? 474 : 430;
    const borderY = spriteImg ? 505 : 480;

    // Code
    ctx.fillStyle = accentColor;
    ctx.font = `bold ${codeSize}px monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(archetype.code, 400, codeY);

    // Name
    ctx.fillStyle = '#f5f0eb';
    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillText(archetype.name, 400, nameY);

    // Tagline
    ctx.fillStyle = '#a3a09d';
    ctx.font = 'italic 20px system-ui, sans-serif';
    ctx.fillText(archetype.tagline, 400, taglineY);

    // Axis labels row
    ctx.fillStyle = '#6b6866';
    ctx.font = '16px monospace';
    ctx.fillText(axisPairs, 400, axisY);

    // Bottom border — archetype color
    ctx.fillStyle = accentColor;
    ctx.fillRect(56, borderY, 688, 2);

    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Canvas toBlob returned null');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast.success('Copied. Go show someone your reader type.');
    } catch {
      toast.error("Couldn't copy the image. Try a different browser.");
    }
  }

  async function handleCopyText() {
    const text = `I am ${archetype.name} (${archetype.code}) on ShelfSprite`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not access clipboard');
    }
  }

  return (
    <Modal labelId={titleId} onClose={onClose} className="w-full max-w-md">
      <div className="rounded-2xl border border-border bg-surface p-6 space-y-5">
        <h2 id={titleId} className="font-display text-lg font-bold text-text">
          Share your reader type
        </h2>

        {/* Share card preview */}
        <div
          ref={cardRef}
          className="relative overflow-hidden rounded-xl bg-elevated border border-border p-6 text-center"
          style={{ minHeight: '220px' }}
        >
          {/* Accent wash */}
          <div
            className="absolute inset-x-0 top-0 h-16 opacity-[0.14]"
            style={{ background: accentColor }}
            aria-hidden="true"
          />
          <p className="relative font-mono text-xs text-muted mb-3">ShelfSprite</p>
          <ReaderSprite code={archetype.code} size={96} className="relative mx-auto mb-3 block" />
          <p
            className="relative font-mono text-5xl font-bold tracking-widest mb-2"
            style={{ color: accentColor }}
          >
            {archetype.code}
          </p>
          <p className="relative font-display text-xl font-bold text-text mb-1">{archetype.name}</p>
          <p className="relative text-sm text-muted italic mb-4">{archetype.tagline}</p>
          <p className="relative font-mono text-xs text-faint">{axisPairs}</p>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <Button variant="secondary" size="md" onClick={handleCopyImage} className="w-full">
            Copy as image
          </Button>
          <Button variant="ghost" size="md" onClick={handleCopyText} className="w-full">
            Copy text
          </Button>
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
