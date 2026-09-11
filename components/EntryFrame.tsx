import BrandLogo from '@/components/BrandLogo';
import ShelfSprite from '@/components/ShelfSprite';

export default function EntryFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="entry-frame min-h-screen bg-base px-5 py-8 sm:px-8">
      <a href="/welcome" aria-label="ShelfSprite home" className="inline-block rounded">
        <BrandLogo priority sizes="180px" className="h-auto w-40 sm:w-44" />
      </a>
      <div className="mx-auto grid w-full max-w-5xl gap-10 py-12 sm:py-20 lg:grid-cols-2 lg:items-center lg:gap-24">
        <div className="entry-story">
          <p className="eyebrow mb-4">A little magic for your reading life</p>
          <h2 className="max-w-[12ch] font-display text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
            Your next chapter starts here.
          </h2>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-muted">
            The books you loved. The ones you couldn&apos;t finish. A reading companion that learns
            from all of them.
          </p>
          <ShelfSprite
            variant="discover"
            sizes="160px"
            className="mt-6 hidden h-40 w-40 lg:block"
          />
        </div>
        <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 sm:p-10">
          {children}
        </div>
      </div>
      <p className="mx-auto max-w-5xl border-t border-border pt-6 text-xs text-muted">
        A personal project by Chase Malcom. Made for readers.
      </p>
    </main>
  );
}
