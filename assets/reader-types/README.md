# ShelfSprite reader-type illustrations

Sixteen transparent mascot illustrations, one for each four-axis reader archetype.
Each design combines the archetype's computed site accent with a distinct visual
metaphor while preserving the ShelfSprite hood, black face, ivory eyes, and book
motif.

## Using the assets

1. Copy the 16 `.webp` files into `frontend/public/reader-types/`.
2. Copy `reader-sprites.ts` into `frontend/lib/readerSprites.ts`.
3. Resolve a profile code with `readerSprite(profile.archetype_code)`.
4. Render the image with meaningful alt text such as `The Plot Mechanic reader type`.

Use WebP in the app and retain PNG as the lossless source/fallback. Every image is
512×512 with genuine alpha transparency and a consistent transparent safety margin.

Suggested display sizes:

- Taste/profile hero: 180–280 px
- Archetype card: 128–180 px
- Compact result/reveal: 96–128 px

`manifest.json` contains the exact hue, surface, vivid color, archetype name, and
filenames for each code. `contact-sheet.png` is a review/reference image, not a
production asset.
