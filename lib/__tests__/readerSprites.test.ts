import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { READER_SPRITES, READER_SPRITE_CODES, readerSprite } from '@/lib/readerSprites';
import { ARCHETYPES } from '@/lib/server/archetype';
import { ARCHETYPE_HUES } from '@/lib/tasteAccent';

interface ManifestEntry {
  name: string;
  hue: number;
  png: string;
  webp: string;
}

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'assets/reader-types/manifest.json'), 'utf8')
) as Record<string, ManifestEntry>;

const CODES = Object.keys(ARCHETYPES);

describe('readerSprites', () => {
  it('covers every archetype code and no others', () => {
    expect(READER_SPRITE_CODES.slice().sort()).toEqual(CODES.slice().sort());
    expect(READER_SPRITE_CODES).toHaveLength(16);
  });

  it('names each sprite exactly as lib/server/archetype.ts names the archetype', () => {
    for (const code of CODES) {
      expect(READER_SPRITES[code]!.name).toBe(ARCHETYPES[code]!.name);
    }
  });

  it('points at artwork that is actually shipped in public/', () => {
    for (const code of CODES) {
      const src = READER_SPRITES[code]!.src;
      expect(src.startsWith('/reader-types/')).toBe(true);
      expect(existsSync(join(process.cwd(), 'public', src.slice(1)))).toBe(true);
    }
  });

  // The artwork was drawn at tasteAccent's hue for each code, so the sprite's body
  // color IS the drenched panel's background color. If either side is ever
  // re-hued without the other, the hero panel silently goes muddy. Pin it.
  it('was drawn at the same hue tasteAccent solves for', () => {
    for (const code of CODES) {
      expect(manifest[code]!.hue).toBe(ARCHETYPE_HUES[code]!);
      expect(manifest[code]!.name).toBe(ARCHETYPES[code]!.name);
    }
  });

  it('serves the exact webp the manifest records', () => {
    for (const code of CODES) {
      expect(READER_SPRITES[code]!.src).toBe(`/reader-types/${manifest[code]!.webp}`);
    }
  });

  it('returns null rather than a broken path for a missing or unknown code', () => {
    expect(readerSprite(null)).toBeNull();
    expect(readerSprite(undefined)).toBeNull();
    expect(readerSprite('')).toBeNull();
    expect(readerSprite('XXXX')).toBeNull();
    expect(readerSprite('toString')).toBeNull();
  });

  it('resolves a known code to its sprite', () => {
    expect(readerSprite('RCDM')).toEqual({
      src: '/reader-types/rcdm-cerebral-architect.webp',
      name: 'The Cerebral Architect',
    });
  });
});
