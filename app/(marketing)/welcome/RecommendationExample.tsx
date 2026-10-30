/**
 * One example recommendation, drawn in the shape of the real swipe card (components/SwipeCard.tsx):
 * a cover, the title and author, a few catalog subjects, and the "Why for you" rationale.
 *
 * A server component with no state, so it is in the prerendered HTML and cannot pop in.
 *
 * The book is real, as every recommendation must be, and the cover is a styled block in the same
 * pattern as the hero's example shelf rather than a cover image. The rationale cites only the books
 * on that example shelf, at the ratings the shelf shows, so the example makes no claim the product
 * would not: reasons are tied to books the reader actually rated.
 */
export default function RecommendationExample() {
  return (
    <figure className="flex flex-col">
      <div className="rounded-2xl border border-border bg-surface p-5 shadow-lg sm:p-6">
        <div className="flex gap-5">
          <div
            className="flex h-36 w-24 shrink-0 flex-col justify-between rounded-r-md border-l-4 border-white/10 bg-[#3d4a3a] p-2 shadow-lg sm:h-40 sm:w-28"
            aria-hidden="true"
          >
            <p className="break-words font-display text-xs font-bold leading-snug text-white sm:text-[13px]">
              Annihilation
            </p>
            <p className="text-[10px] leading-relaxed text-white/80">Jeff VanderMeer</p>
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <div>
              <p className="eyebrow mb-2">Recommended for you</p>
              <h3 className="font-display text-xl font-bold leading-tight text-text">
                Annihilation
              </h3>
              <p className="text-sm text-muted">Jeff VanderMeer · 2014</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {['science fiction', 'weird fiction', 'exploration'].map((subject) => (
                <span
                  key={subject}
                  className="inline-flex items-center rounded-full bg-elevated px-2.5 py-0.5 font-mono text-xs font-medium text-muted"
                >
                  {subject}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-5 border-t border-border pt-4">
          <p className="mb-1 font-mono text-xs uppercase tracking-widest text-faint">Why for you</p>
          <p className="text-sm leading-relaxed text-text">
            You gave Piranesi and Never Let Me Go five stars, and both are told by narrators who
            understand less about where they are than you do. Annihilation&apos;s biologist is that
            kind of narrator, and like The Left Hand of Darkness, it treats its strange place as
            something to think through rather than scenery.
          </p>
        </div>
      </div>
      <figcaption className="mt-3 text-xs text-muted">
        An example pick for the shelf above. Your own picks cite the books you rated.
      </figcaption>
    </figure>
  );
}
