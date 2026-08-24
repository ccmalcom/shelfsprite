import Image from 'next/image';

/**
 * The hero's product argument, drawn rather than screenshotted: one row of a real Goodreads
 * export resolving into the enriched catalog record ShelfSprite actually stores.
 *
 * A server component with no state. The staged entrance is pure CSS (see the `ss-rise` /
 * `ss-draw` block in globals.css) and the composed state is what renders when no animation
 * runs at all, so this can never ship as an empty frame.
 *
 * The values are the real ones for this book — Open Library resolves Piranesi to a 2020
 * first publication at 245 pages — so the artifact is not making a claim the product would not.
 */

/** One `label: value` line of the resolved record. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 font-mono text-[11px] leading-relaxed">
      <span className="w-14 shrink-0 text-faint">{label}</span>
      <span className="text-muted">{children}</span>
    </div>
  );
}

export default function ResolveArtifact() {
  return (
    <div className="flex flex-col items-stretch">
      {/* The raw material: what Goodreads actually hands you. */}
      <div className="ss-rise overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="h-2 w-2 rounded-full bg-border-strong" aria-hidden="true" />
          <span className="font-mono text-[11px] text-faint">goodreads_library_export.csv</span>
        </div>
        {/* Horizontal scroll is contained here so the page body never scrolls sideways. */}
        <div className="overflow-x-auto">
          <pre className="w-max px-3 py-3 font-mono text-[11px] leading-relaxed text-faint">
            <span className="text-muted">Title,Author,My Rating,Date Read</span>
            {'\n'}
            Piranesi,Susanna Clarke,5,2024-03-11
          </pre>
        </div>
      </div>

      {/* The move itself, named. A drawn connector with the step's own word on it, which ties
          the hero to the numbered sequence further down the page. */}
      <div className="flex items-center gap-3 py-3 pl-6" aria-hidden="true">
        <div className="ss-draw h-9 w-px bg-border-strong" style={{ animationDelay: '520ms' }} />
        <span
          className="ss-rise font-mono text-[11px] text-accent"
          style={{ animationDelay: '600ms' }}
        >
          enrich
        </span>
      </div>

      {/* What ShelfSprite stores once the catalog has been consulted. */}
      <div
        className="ss-rise rounded-xl border border-border bg-surface p-4"
        style={{ animationDelay: '700ms' }}
      >
        <div className="flex gap-4">
          <Image
            src="/marketing/piranesi-cover.jpg"
            alt=""
            aria-hidden="true"
            width={200}
            height={300}
            sizes="72px"
            className="h-[108px] w-[72px] shrink-0 rounded border border-border object-cover"
          />
          <div className="flex min-w-0 flex-col gap-1.5">
            <div>
              <p className="font-display text-lg font-bold leading-tight text-text">Piranesi</p>
              <p className="text-sm text-muted">Susanna Clarke</p>
            </div>
            <div className="flex items-center gap-2">
              {/* A JSX text node, not a JS string literal: non-ASCII in a .tsx string literal
                  can be rejected by Turbopack (docs/conventions.md). */}
              <span className="text-sm tracking-tight text-accent" aria-hidden="true">
                ★★★★★
              </span>
              <span className="font-mono text-[11px] text-faint">your rating</span>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-1 border-t border-border pt-3">
          <Field label="year">2020</Field>
          <Field label="length">245 pages</Field>
          <Field label="subjects">fantasy · labyrinths · amnesia</Field>
          <Field label="match">
            <span className="rounded bg-success-quiet px-1.5 py-0.5 text-success">HIGH</span>
          </Field>
        </div>
      </div>
    </div>
  );
}
