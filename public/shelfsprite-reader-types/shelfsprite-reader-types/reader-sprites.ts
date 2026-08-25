export type ReaderCode =
  | 'IPBH' | 'IPBM' | 'IPDH' | 'IPDM'
  | 'ICBH' | 'ICBM' | 'ICDH' | 'ICDM'
  | 'RPBH' | 'RPBM' | 'RPDH' | 'RPDM'
  | 'RCBH' | 'RCBM' | 'RCDH' | 'RCDM';

const BASE = '/reader-types';

export const READER_SPRITES: Record<ReaderCode, string> = {
  IPBH: `${BASE}/ipbh-wandering-escapist.webp`,
  IPBM: `${BASE}/ipbm-plot-mechanic.webp`,
  IPDH: `${BASE}/ipdh-serial-thrill-seeker.webp`,
  IPDM: `${BASE}/ipdm-genre-architect.webp`,
  ICBH: `${BASE}/icbh-empathic-rover.webp`,
  ICBM: `${BASE}/icbm-character-analyst.webp`,
  ICDH: `${BASE}/icdh-devoted-fan.webp`,
  ICDM: `${BASE}/icdm-deep-empath.webp`,
  RPBH: `${BASE}/rpbh-conscious-adventurer.webp`,
  RPBM: `${BASE}/rpbm-eclectic-critic.webp`,
  RPDH: `${BASE}/rpdh-committed-purist.webp`,
  RPDM: `${BASE}/rpdm-structural-connoisseur.webp`,
  RCBH: `${BASE}/rcbh-literary-wanderer.webp`,
  RCBM: `${BASE}/rcbm-cerebral-explorer.webp`,
  RCDH: `${BASE}/rcdh-canon-keeper.webp`,
  RCDM: `${BASE}/rcdm-cerebral-architect.webp`,
};

export function readerSprite(code: string | null | undefined): string | null {
  if (!code || !(code in READER_SPRITES)) return null;
  return READER_SPRITES[code as ReaderCode];
}
