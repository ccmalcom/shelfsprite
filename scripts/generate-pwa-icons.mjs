// Regenerates the install icons in public/icons/ from app/icon.svg, the app's own mark.
// Run by hand after the mark changes: `node scripts/generate-pwa-icons.mjs`.
//
// `sharp` is not a direct dependency: it arrives with Next.js, which uses it for image
// optimization. That is enough for an operator script that runs on a developer machine.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'app/icon.svg'), 'utf8');

// The "any" icons are the mark exactly as the favicon draws it: a rounded warm-black tile.
const anySvg = source;

// Maskable icons are cropped by the launcher to a circle, squircle or rounded square, so the
// background must reach every edge and the artwork must sit inside the central safe zone (a
// circle 80% of the icon's width). Drop the rounded tile, paint a full-bleed square, and shrink
// the mark around its centre: its farthest corner then lands at about 38% of the width from the
// centre, inside the 40% safe radius.
const tile = /<rect width="64" height="64" rx="12" fill="(#[0-9a-fA-F]{6})"\/>/;
const match = source.match(tile);
if (!match) throw new Error('app/icon.svg no longer starts with the expected rounded tile');
const background = match[1];
const artwork = source
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(tile, '');
const maskableSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" fill="${background}"/>` +
  `<g transform="translate(32 32) scale(0.66) translate(-32 -32.5)">${artwork}</g></svg>`;

async function render(svg, size, file) {
  const out = join(root, 'public/icons', file);
  const png = await sharp(Buffer.from(svg), { density: (72 * size) / 64 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(out, png);
  console.log(`wrote public/icons/${file}`);
}

await render(anySvg, 192, 'icon-192.png');
await render(anySvg, 512, 'icon-512.png');
await render(maskableSvg, 192, 'maskable-192.png');
await render(maskableSvg, 512, 'maskable-512.png');
