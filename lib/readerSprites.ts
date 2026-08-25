// The sixteen reader-type illustrations. Each was drawn at its code's hue from
// lib/tasteAccent.ts, so a sprite and the drenched panel it sits on share a color;
// lib/__tests__/readerSprites.test.ts pins that agreement, and pins these names to
// lib/server/archetype.ts::ARCHETYPES.
//
// Client components import this module, so it deliberately imports nothing --
// same reasoning as the dependency-free rule on lib/server/rating.ts. The names
// are duplicated here rather than imported from lib/server/ for that reason; the
// test is what keeps the copy honest.

export interface ReaderSpriteAsset {
  /** Public path to the 512x512 transparent WebP. */
  src: string;
  /** Archetype display name, e.g. "The Plot Mechanic". */
  name: string;
}

const BASE = '/reader-types';

export const READER_SPRITES: Record<string, ReaderSpriteAsset> = {
  IPBH: { src: `${BASE}/ipbh-wandering-escapist.webp`, name: 'The Wandering Escapist' },
  IPBM: { src: `${BASE}/ipbm-plot-mechanic.webp`, name: 'The Plot Mechanic' },
  IPDH: { src: `${BASE}/ipdh-serial-thrill-seeker.webp`, name: 'The Serial Thrill-Seeker' },
  IPDM: { src: `${BASE}/ipdm-genre-architect.webp`, name: 'The Genre Architect' },
  ICBH: { src: `${BASE}/icbh-empathic-rover.webp`, name: 'The Empathic Rover' },
  ICBM: { src: `${BASE}/icbm-character-analyst.webp`, name: 'The Character Analyst' },
  ICDH: { src: `${BASE}/icdh-devoted-fan.webp`, name: 'The Devoted Fan' },
  ICDM: { src: `${BASE}/icdm-deep-empath.webp`, name: 'The Deep Empath' },
  RPBH: { src: `${BASE}/rpbh-conscious-adventurer.webp`, name: 'The Conscious Adventurer' },
  RPBM: { src: `${BASE}/rpbm-eclectic-critic.webp`, name: 'The Eclectic Critic' },
  RPDH: { src: `${BASE}/rpdh-committed-purist.webp`, name: 'The Committed Purist' },
  RPDM: { src: `${BASE}/rpdm-structural-connoisseur.webp`, name: 'The Structural Connoisseur' },
  RCBH: { src: `${BASE}/rcbh-literary-wanderer.webp`, name: 'The Literary Wanderer' },
  RCBM: { src: `${BASE}/rcbm-cerebral-explorer.webp`, name: 'The Cerebral Explorer' },
  RCDH: { src: `${BASE}/rcdh-canon-keeper.webp`, name: 'The Canon Keeper' },
  RCDM: { src: `${BASE}/rcdm-cerebral-architect.webp`, name: 'The Cerebral Architect' },
};

/** Canonical display order for the "all sixteen" grid. */
export const READER_SPRITE_CODES: string[] = Object.keys(READER_SPRITES);

export function readerSprite(code: string | null | undefined): ReaderSpriteAsset | null {
  if (!code) return null;
  if (!Object.prototype.hasOwnProperty.call(READER_SPRITES, code)) return null;
  return READER_SPRITES[code]!;
}
