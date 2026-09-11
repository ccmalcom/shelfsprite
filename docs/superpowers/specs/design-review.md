# ShelfSprite design review — September 11, 2026

ShelfSprite has recognizable brand assets, but the everyday interface does not yet turn them into a coherent product experience. My assessment is that hierarchy, book presentation, and product voice account for more of the unfinished feeling than the logo or individual component styling.

This is a review and proposed direction, not an approved redesign or an implementation plan. No application files were changed.

## Evidence and scope

Reviewed the current checkout, its frontend conventions, existing marketing screenshots, and the actual Next.js UI in an isolated local copy. Captured Home, Library, Discover, Profile, and Swipe at 1440×1000 and 390×844; Library also at 768×1024; Welcome and Login at desktop size. Exercised the Discover form with intercepted, synthetic responses. Measured page geometry and computed styles in Chrome.

The local preview used six synthetic books, three sample traits, a reader archetype, and one reading goal. It used no account credentials, real database, or paid AI calls. Missing covers in these new captures are deliberate fixture omissions, not evidence of a production catalog problem. Existing marketing screenshots provide an additional view with multiple real covers. Exact layout positions vary with content. The Next.js development badge in the lower left is not part of the product and is excluded from the findings. Authentication, server mutations, real recommendation quality, and the complete onboarding/settings flows were not exercised.

## What is already worth keeping

- The ShelfSprite name and hooded reader mark are memorable and relevant.
- Bricolage Grotesque supplies a recognizable heading voice. A wholesale font replacement is unnecessary.
- Reader sprites and archetypes provide a strong personal connection. Their prominence needs to depend on the screen and the moment.
- Recommendations grounded in a reader's books are a meaningful product story. Show the connection prominently.
- The existing restrained layout and library list are useful foundations. A polished interface can retain efficient list browsing.

## Findings, ordered by impact

### 1. The home page postpones the product's main benefit

The sequence is greeting → full reader-type panel → library statistics → annual statistics/goals → ratings chart → recommendation action. In the sample, “Find my next books” starts at approximately **y=1666 on desktop and y=1941 on mobile**. The phone's initial screen is occupied almost entirely by the archetype identity panel.

The panel is an appealing reveal moment, but showing its full explanation, trait chips, axes, and regeneration controls on every visit makes Home behave like another Profile screen. The source actually uses the larger `TasteHero` on Home and its compact form on Profile.

**Proposed change:** lead the returning-reader home page with the next useful action, an existing recommendation preview where available, and currently reading books. Keep a compact reader identity nearby. Move detailed taste axes and rating analysis to Profile. Preserve reading goals as a supporting section.

**Acceptance:** at 390×844 and 1440×1000, the main action and a meaningful reading-related preview or empty-state message appear in the initial viewport. No invented recommendations or unsupported “because you liked” claims.

Evidence: [desktop Home](screens/home-1440.png), [mobile Home](screens/home-390.png). Owners: `app/(main)/page.tsx`, `components/TasteHero.tsx`, `components/YearCard.tsx`.

### 2. The shell continually frames the experience as a beta test

The desktop page gives an entire top strip and a prominent orange button to “Share feedback on the beta.” On mobile, an orange Feedback button floats over normal content. In the Swipe capture it overlaps the “More like this” action: their rectangles intersect by approximately 42×26 pixels.

This makes feedback collection visually compete with the reader's reason for using the app. It also contributes directly to the impression Chase described.

**Proposed change:** keep feedback accessible in a quiet Help/account location and at appropriate completion moments. Reserve high-emphasis orange actions for the current reading task. Preserve existing feedback capabilities and prompts without the persistent competing banner/button.

Evidence: [mobile Swipe](screens/swipe-390.png). Owner: `components/FeedbackLauncher.tsx`.

### 3. Books are visually subordinate to the controls

Library presents small covers, long rows, and several bands of controls. On mobile, the first book starts around halfway down the screen; title truncation occurs while ratings and favorites consume fixed space. The existing marketing library screenshot shows the same basic emphasis with populated covers.

Discover begins with a small search field and a largely empty page. The sprite helps identify the page, but there is little guidance or anticipation. Results use small titles and 12px rationale text, weakening the part that explains why a book is interesting.

**Proposed change:** give Library a stronger cover-and-title hierarchy, a more compact toolbar, and a layout that accommodates long titles. Retain the efficient list; explore an optional cover grid only if it earns its additional complexity. Give Discover visible example requests, a generous query field, and richer result rows that foreground the reason for the match. Example requests should prefill the query and leave submission deliberate.

Evidence: [mobile Library](screens/library-390.png), [desktop Discover](screens/discover-1440.png), [Discover results](screens/discover-results-390.png). Owners: `app/(main)/library/page.tsx`, `app/(main)/discover/page.tsx`.

### 4. The visual language changes personality between sections

Most screens use dark brown neutrals, orange actions, compact utility typography, monochrome labels, and rounded containers. Reader-type panels introduce large saturated fields and a more illustrated character style. The orange role sprites use a flatter graphic treatment. The assets share the hooded-reader idea, but their rendering and presentation differ visibly.

Orange also appears in ratings, graphs, actions, navigation, and feedback. Several semantic roles therefore have similar emphasis. Colorful reader panels dominate while book imagery receives little space.

**Proposed change:** define stable roles for brand color, reader identity, status, and book imagery. Keep reader colors concentrated in personal identity elements; make book covers and reading content the dominant imagery on browsing screens. Establish consistent illustration rules for scale, line weight, surrounding space, and when a sprite appears. Use fewer prominent container borders and more deliberate section spacing. Reduce monospace prose and long trait chips; reserve mono for compact numerical information.

Owners: `app/globals.css`, `tailwind.config.ts`, `components/ui/`, `components/ShelfSprite.tsx`, `components/ReaderSprite.tsx`.

### 5. Product copy exposes the machinery

Examples include “Re-derive,” “live catalog,” “Claude inferred these,” and the marketing emphasis on CSV enrichment and deterministic retrieval. “Swipe” names an interaction rather than the benefit of personalized recommendations. Login's “Ask the admin for an account” also sounds internal.

The Welcome page has a stronger composition than the app, but its hero artifact demonstrates data processing. It makes the engineering case before fully showing the reader's reward.

**Proposed change:** lead with reading outcomes and keep technical explanation available as supporting detail. Candidate copy to test:

| Current                                                              | Proposed direction                             |
| -------------------------------------------------------------------- | ---------------------------------------------- |
| Swipe                                                                | For you                                        |
| Re-derive                                                            | Refresh reader type                            |
| Ask for anything and get real books off the live catalog, explained. | What are you in the mood to read?              |
| Claude inferred these from your ratings.                             | What your favorite books say about your taste. |
| Ask the admin for an account.                                        | Request an invite.                             |

“Request an invite” should link to the existing waitlist. These are editorial proposals, not approved navigation or behavior changes. Keep clear cost/duration and configuration information where it helps a reader make a decision.

Evidence: [Welcome](screens/welcome-1440.png), [Login](screens/login-1440.png). Owners: `lib/nav.ts`, `components/TasteHero.tsx`, marketing/login pages.

### 6. Concrete rendering defects undercut polish

- **Almost invisible Already read symbol:** the `R` span uses `text-base`, which is a background-color token in this repository. Its computed text color is `rgb(22,20,18)` against a `rgb(31,27,24)` button. Replace the conflicting class and evaluate an understandable icon with a visible action label.
- **Transparent navigation:** both navigation elements computed to `rgba(0,0,0,0)`, despite the intended `bg-base/90`. The full-color CSS variable cannot support that Tailwind alpha modifier as currently configured. Content bleeds through the mobile bar, most visibly over the saturated profile panel. Use an alpha-capable token or an explicit color expression.
- **Trait treatments lose their intended color:** classes such as `border-success/30` and `bg-success/5` use the same incompatible pattern. Rendered trait outlines appear bright rather than the intended quiet semantic border. Audit actual emitted styles when correcting the token family.
- **Recommendation rationale requires internal scrolling:** the fixed-height Swipe card places About before Why for you. On the phone capture, the personalized reason is below the card's visible content area. Prioritize the rationale and rethink the fixed card height while preserving swipe and accessible button controls.

Owners: `app/(main)/swipe/page.tsx`, `components/SwipeCard.tsx`, `components/NavBar.tsx`, `components/BottomNav.tsx`, `app/(main)/profile/page.tsx`, `tailwind.config.ts`.

No document-level horizontal overflow appeared at the tested widths. This is not a complete accessibility or responsive audit.

## Recommended direction

Aim for **a personal reading companion with an editorial presentation and a little magic**. Let typography, book covers, useful recommendations, and a restrained sprite presence carry that feeling.

Two coherent visual options are worth comparing before implementation:

| Direction                                                | Treatment                                                                                                                      | Tradeoff                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Refine the existing palette                              | Keep warm charcoal and cream; reduce orange to key actions and the mark; unify sprite presentation                             | Greatest continuity and smallest asset change                                                                          |
| Cool reading room — recommended for Chase's stated taste | Deep ink/slate surfaces, soft ivory text, restrained orange brand mark, cooler supporting accents; keep archetype colors local | Better matches the saved cooler-palette preference; requires careful harmony with the orange logo and all reader types |

Both options need the hierarchy and content changes above. A color swap by itself will leave the same experience. Keep the current brand assets during the first exploration; treat any new illustration work as a separate decision. If themes are in scope, make them user-selectable rather than replacing one fixed theme with another.

## Handoff for the next design stage

1. Compare two concrete visual compositions of the same populated Home and Library screens, each at desktop and phone sizes. Use the palette options above with shared content so the differences are assessable.
2. Resolve the chosen visual direction before broad implementation. Carry it through Discover and a recommendation detail/decision screen before calling the system settled.
3. Implement the shell and token defects, then Home hierarchy and feedback placement, then book presentation and supporting profile/copy changes. Confirm the actual data paths for any Home previews before promising them.
4. Validate empty, populated, loading, failure, missing-cover, long-title, and stale-profile states. Check phone/tablet navigation with both ordinary and admin sessions. Keep overlays from covering content and ensure touch actions are comfortably operable.
5. Exercise real user flows and run the repository's two test runners, type check, lint, formatting, and required Next build when implementation occurs. Preserve auth, tenancy, recommendation grounding, ratings, and import invariants.

Suggested next-session prompt:

> Read this review and the repository instructions. Create two reviewable Home and Library design concepts, using the existing logo and reader sprites, with desktop and mobile layouts. Compare a refined version of the existing palette with the recommended cooler direction. Put reading actions and books first, make feedback unobtrusive, and retain efficient library browsing. This is a design exploration; do not implement the application redesign until I choose a direction.
