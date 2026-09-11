# Home & Library design exploration

September 11, 2026. **Chosen: Ink & Paper’s layout with Ember & Ivory’s warm palette.** Chase subsequently authorized implementation. The original comparison below remains a record of the alternatives; see [implementation and verification](implementation.md) for the application changes. The application has not been deployed.

Open [the comparison page](index.html) in a browser. It works directly from the checkout without a development server. Switch Home/Library and Desktop/Phone to compare all eight screens. Click a screenshot for full size, or use “Explore concept” for the interactive prototype. In Phone mode, “Try at phone width” opens a constrained interactive preview. Keep this folder in the repository: brand images reference `../../../public/`.

Source: [September 11 design review](../../superpowers/specs/design-review.md), repository instructions, current Home/Library source, frontend/conventions docs, and Chase's saved design preferences. The original review remains untouched.

## The two proposals

| Decision             | A: Ember & Ivory                                                          | B: Ink & Paper                                                                   |
| -------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Overall feel         | Warm, familiar, quietly bookish                                           | Cooler, calmer, more editorial                                                   |
| Shell on desktop     | Horizontal navigation; broad reading area                                 | Compact left rail; persistent navigation and Help                                |
| Home composition     | Contained recommendation action with a slightly tilted saved cover        | Open composition divided by rules; upright saved cover                           |
| Page / surface       | `#191613` / `#24201c`                                                     | `#121c26` / `#1b2936`                                                            |
| Text / muted text    | `#f5f0e8` / `#b7ab9c`                                                     | `#f3f0e8` / `#adbcc8`                                                            |
| Primary action       | Softened coral `#ff7959`, dark label                                      | Pale blue `#b3cddc`, dark label                                                  |
| Existing orange logo | Closely harmonizes with warm surfaces                                     | A small warm signature against slate; retained unchanged                         |
| Reader identity      | Small pink accent, unaltered sprite                                       | Same pink accent and sprite, concentrated in a small identity card               |
| Tradeoff             | Greatest continuity; warm controls still feel close to the existing brand | Better palette fit for Chase; rail uses horizontal space and needs tablet review |

**Recommendation: B's palette.** Its cooler surfaces let the existing orange logo and colorful books stay distinct. The rail is an independent proposal: B's palette can use A's horizontal navigation if browsing width wins. Both retain Bricolage Grotesque headings and Inter body copy. Neither palette nor navigation arrangement is approved. If themes enter implementation scope, make the approved themes user-selectable in Settings.

## Shared hierarchy and behavior

- Home leads with “Find my next books,” a real book on the sample to-read shelf, and currently reading books with “Mark finished.” The full reader profile and rating analysis stay out of the returning-reader Home composition. Reader identity remains visible as a compact sprite/link; reading goals follow the reading content on mobile.
- This Home models **no persisted recommendation preview loaded**, with saved and currently reading books available. The saved Piranesi cover is labeled “On your to-read shelf.” It is not presented as an AI recommendation. A future populated recommendation preview must use returned records and their stored rationale/grounding, never fabricated claims.
- Library remains a list. Covers, full wrapping titles, and authors lead; desktop ratings and dates align in columns. Mobile ratings sit below authors. Search is scoped to the current shelf; sort and filters remain available. Read, To read, Reading, DNF, and Rejected are all reachable; narrow screens scroll the shelf strip inside the page. An optional grid has not been added.
- Favorites and half ratings remain explicit. Stars use ivory, favorites use a local pink accent, and reading-goal progress uses muted green. Brand, personal identity, and status do not all share the same orange emphasis.
- Feedback moves into desktop Help / Help & feedback and mobile Account → Help & feedback → Share feedback. No persistent beta banner or floating feedback control competes with reading. The existing production feedback form and eligible completion prompts must be retained when implemented; the prototype only demonstrates access.
- The mobile bar has five destinations and an opaque background, with reserved bottom space. “For you” is proposed copy for the existing Swipe destination, not a new route or a settled rename. Desktop Settings remains accessible via account in A and rail in B; mobile Settings stays in Account.

## What can be exercised

Working locally on fixtures: Home/Library navigation, reading-shelf links, all shelf buttons, title/author search, title/rating sorting, favorites filter, minimum-rating filter, clearing filters, favorite toggle, no-results and empty-shelf states, dialogs with Escape/focus return, account/Help/feedback entry, and the comparison controls/phone preview.

Book details, finish/rating actions, recommendation generation, Add book, Profile, Settings, Discover, and goals open **explicit design handoff dialogs**. They do not simulate a successful mutation. Favorites are in-memory only and reset on reload. No APIs, storage, credentials, AI calls, or submissions are used. The default “Recently read” fixture order follows its sample dates; non-read shelves retain fixture order. This is not production sorting or persistence code.

## Assets and content provenance

- The logo references the existing dark SVG in `public/shelfsprite-logo-kit/` unchanged, including the mark's warm backing visible against slate.
- The compact reader is the existing `icbh-empathic-rover.webp`. The existing sleeping sprite appears on empty shelves. Decorative sprites have empty alt text next to descriptive copy. Unknown reader types should retain the application's text-only fallback when implemented.
- Piranesi uses the existing `public/marketing/piranesi-cover.jpg`. Other covers are **typographic placeholders**, not official jacket designs, generated as HTML/CSS rather than new illustration assets. One book deliberately has no cover. Actual catalog covers will change the balance of color; review the chosen palette with more real covers before settling it.
- All book titles are real. The persona, shelves, dates, favorites, ratings, and goal are synthetic. The fixture contains twelve books: six read, three to-read, two reading, one DNF, and no rejected recommendations.
- `assets/bricolage-latin.woff2` and `assets/inter-latin.woff2` are copies of the application's already downloaded Next font assets. They make these mockups independent of the transient `.next` directory. No replacement brand assets or fonts were introduced to the application.

## Verification

Rendered in headless Chrome using the local files. Captured both concepts' Home and Library at **1440 × 1000** and **390 × 844**, and exercised both pages at **320 px** and **768 px** as additional geometry checks. No document-level horizontal overflow or missing image loads occurred. Local fonts loaded. The fixed mobile bar is opaque; ordinary page content can scroll fully above it.

| Measured at initial viewport       |      A |      B |
| ---------------------------------- | -----: | -----: |
| Home primary action top, desktop   | 448 px | 379 px |
| Home primary action top, phone     | 425 px | 432 px |
| First current-read card top, phone | 574 px | 581 px |
| First Library row top, desktop     | 381 px | 297 px |
| First Library row top, phone       | 323 px | 323 px |

Both phone Home screens show the full primary action and one full currently reading entry before the bottom bar. Phone Library shows four entries, with the fourth entry's content visible above the bar. Desktop Library rows are approximately 105 px tall. Geometry is specific to these fixtures, fonts, and viewport sizes.

**45 browser checks passed**, covering the interactions above, responsive geometry/image loads, and comparison controls. See [layout measurements](screens/layout-checks.json) and [interaction checks](screens/interaction-checks.json). JavaScript syntax, targeted ESLint, and Prettier checks passed. Application tests and Next build were not run: this task adds isolated documentation prototypes and does not implement application behavior.

Calculated text contrast: A's main text on surface is 14.26:1, muted text on raised surface 6.29:1, and primary button text 6.94:1. B's corresponding ratios are 13.01:1, 6.31:1, and 9.47:1. These are selected token-pair checks, not a complete accessibility audit. Full keyboard/screen-reader behavior, mobile hit targets, all archetype colors, and admin navigation remain implementation validation work.

## Chosen direction and implementation

The desktop rail, open Home composition, compact reader identity, and list-first Library follow Ink & Paper. Colors follow Ember & Ivory. Mobile uses five primary destinations and an Account menu. Existing route labels remain; the proposed “For you” rename was not part of the visual choice.

Chase explicitly authorized implementing the selected direction after reviewing these concepts. Home, Library, and the shared shell are implemented; see [implementation.md](implementation.md) for scope, verification, and a file-backed handoff. Discover and recommendation decision screens inherit the shell and palette, but their full content redesign remains a separate design pass.
