import type { Metadata } from 'next';
import Image from 'next/image';
import BrandLogo from '@/components/BrandLogo';
import ShelfSprite from '@/components/ShelfSprite';
import InviteHashRedirect from '@/components/InviteHashRedirect';
import WaitlistForm from './WaitlistForm';
import ResolveArtifact from './ResolveArtifact';

/**
 * The public marketing page. Served at / for signed-out visitors through the rewrite in
 * utils/supabase/middleware.ts, and directly reachable at /welcome (the only way to see it in
 * local mode, where middleware no-ops and / renders the dashboard).
 *
 * canonical: '/' so crawlers that reach /welcome directly attribute the page to the URL people
 * actually share. The root layout already sets the global title; only the description is
 * overridden here so the tab reads the same everywhere. No Open Graph image: that is a separate
 * design task with its own asset pipeline.
 *
 * Never write `text-base` on this page. `base` is a registered COLOR token (tailwind.config.ts),
 * and Tailwind resolves the shared `text-*` namespace to textColor over fontSize — so
 * `sm:text-base` silently paints body copy in the page background color. Use an explicit size.
 */
export const metadata: Metadata = {
  description:
    'Import your Goodreads library, get a taste profile built from what you actually rated, ' +
    'and get recommendations for real books that exist.',
  alternates: { canonical: '/' },
};

const STEPS = [
  {
    variant: 'analyze' as const,
    title: 'Import',
    body: 'Bring your Goodreads export, or start small by adding books yourself. Your ratings give ShelfSprite a place to begin.',
  },
  {
    variant: 'discover' as const,
    title: 'Enrich',
    body: 'Your books become a connected library, with covers, subjects, and catalog details. Uncertain matches stay flagged for you to check.',
  },
  {
    variant: 'success' as const,
    title: 'Recommend',
    body: 'Find real books with reasons tied to your taste. Save the ones that catch your eye and tell ShelfSprite what missed.',
  },
];

export default function WelcomePage() {
  return (
    <>
      <InviteHashRedirect />
      <header className="mx-auto flex max-w-6xl items-center justify-between gap-5 border-b border-border px-5 py-5 sm:px-8">
        <BrandLogo priority sizes="180px" className="h-auto w-36 sm:w-44" />
        <nav aria-label="Public navigation" className="flex items-center gap-6 text-sm">
          <a href="#how-it-works" className="hidden text-muted hover:text-text sm:block">
            How it works
          </a>
          <a
            href="/login"
            className="rounded-lg border border-border-strong px-4 py-2 text-text hover:bg-surface"
          >
            Sign in
          </a>
        </nav>
      </header>
      <main>
        <section className="marketing-section">
          <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
            <div>
              <p className="eyebrow mb-5">For the love of the next good book</p>
              <h1 className="max-w-[14ch] text-balance font-display text-[2.75rem] font-bold leading-[1.06] tracking-tight sm:text-6xl">
                A reading life that feels like <span className="text-accent">you.</span>
              </h1>
              <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">
                Keep your shelves close. Understand what moves you. Find your next favorite among
                real books, chosen with your taste in mind.
              </p>
              <div className="mt-8 max-w-sm">
                <WaitlistForm />
              </div>
              <p className="mt-4 text-xs text-muted">
                A small, invite-only project. Built by a reader.
              </p>
            </div>
            <div className="relative rounded-2xl border border-border bg-surface p-6 sm:p-8">
              <div className="flex items-center justify-between border-b border-border pb-5">
                <div>
                  <p className="eyebrow">Between the covers</p>
                  <h2 className="mt-2 font-display text-2xl font-bold">There is a thread.</h2>
                </div>
                <ShelfSprite
                  variant="discover"
                  priority
                  sizes="96px"
                  className="h-24 w-24 shrink-0"
                />
              </div>
              <p className="mt-6 text-sm leading-relaxed text-muted">
                The strange worlds. The complicated people. The endings you kept thinking about.
              </p>
              <div
                className="my-6 grid grid-cols-3 items-end gap-3"
                aria-label="An illustrative reading shelf"
              >
                {[
                  ['Piranesi', 'Susanna Clarke', 'bg-[#344941]'],
                  ['The Left Hand of Darkness', 'Ursula K. Le Guin', 'bg-[#524337]'],
                  ['Never Let Me Go', 'Kazuo Ishiguro', 'bg-[#434052]'],
                ].map(([title, author, color], i) => (
                  <div
                    key={title}
                    className={`${color} flex min-h-44 flex-col justify-between rounded-r-md border-l-4 border-white/10 p-3 shadow-lg sm:min-h-52`}
                  >
                    <span className="font-mono text-[10px] text-white/70">0{i + 1}</span>
                    <p className="my-3 font-display text-sm font-bold leading-snug text-white sm:text-lg">
                      {title}
                    </p>
                    <p className="text-[10px] leading-relaxed text-white/80">{author}</p>
                  </div>
                ))}
              </div>
              <div className="border-t border-border pt-5">
                <p className="text-sm leading-relaxed text-text">
                  Your books tell a story about you.
                  <br />
                  ShelfSprite helps you follow it.
                </p>
                <p className="mt-3 text-xs text-muted">
                  An example shelf. Your profile begins with your own books.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="border-y border-border bg-surface/50 scroll-mt-6">
          <div className="marketing-section">
            <p className="eyebrow mb-4">From your shelves to your next read</p>
            <h2 className="mb-10 font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Start with what you&apos;ve read.
            </h2>
            <ol className="grid gap-10 sm:grid-cols-3 sm:gap-8">
              {STEPS.map((step, i) => (
                <li key={step.title} className="border-t border-border pt-5">
                  <div className="mb-4 flex items-baseline gap-3">
                    <span className="font-mono text-xs text-accent">0{i + 1}</span>
                    <h3 className="font-display text-xl font-bold">{step.title}</h3>
                  </div>
                  <p className="text-sm leading-relaxed text-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="marketing-section">
          <div className="mb-10 flex flex-wrap items-end justify-between gap-5">
            <div>
              <p className="eyebrow mb-4">A home for every chapter</p>
              <h2 className="max-w-md font-display text-3xl font-bold tracking-tight sm:text-4xl">
                Less managing.
                <br />
                More reading.
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-muted">
              Your current read, your old favorites, and the books waiting their turn. A little
              order, with room for curiosity.
            </p>
          </div>
          <figure className="mx-auto max-w-[1000px]">
            <Image
              src="/marketing/library-reading-room.png"
              alt="The ShelfSprite library, listing books with their covers, half-star ratings and shelf counts"
              width={2400}
              height={1600}
              sizes="(max-width: 1000px) 100vw, 1000px"
              className="h-auto w-full rounded-xl border border-border"
            />
            <figcaption className="mt-3 text-xs text-muted">
              An example library in ShelfSprite. All your shelves in one place.
            </figcaption>
          </figure>
        </section>

        <section className="border-y border-border bg-surface">
          <div className="marketing-section grid items-center gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
            <div>
              <p className="eyebrow mb-4">Real books. Reasons that matter.</p>
              <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                The books it recommends exist
              </h2>
              <p className="mt-6 text-sm leading-relaxed text-muted">
                ShelfSprite searches real catalogs first. Then Claude ranks those books and explains
                how they connect to your taste. Every pick has a title you can find and a reason you
                can judge.
              </p>
            </div>
            <ResolveArtifact />
          </div>
        </section>

        <section className="marketing-section">
          <div className="mb-10 grid gap-6 lg:grid-cols-2 lg:gap-16">
            <div>
              <p className="eyebrow mb-4">Get to know your own taste</p>
              <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                A profile built from evidence
              </h2>
            </div>
            <div className="space-y-4 text-sm leading-relaxed text-muted">
              <p>
                Your ratings reveal patterns. Your reviews explain why. ShelfSprite brings them
                together into a profile you can recognize, question, and refine.
              </p>
              <p>
                Each trait points back to your books. Confirm what fits, reject what doesn&apos;t,
                and let your profile grow with your reading.
              </p>
            </div>
          </div>
          <figure className="mx-auto max-w-[1000px]">
            <Image
              src="/marketing/taste-profile-reading-room.png"
              alt="A ShelfSprite taste profile showing the reader archetype and traits grounded in their books"
              width={2400}
              height={2100}
              sizes="(max-width: 1000px) 100vw, 1000px"
              className="h-auto w-full rounded-xl border border-border"
            />
            <figcaption className="mt-3 text-xs text-muted">
              An example profile. Every reader brings a different story.
            </figcaption>
          </figure>
        </section>

        <section id="join" className="scroll-mt-6 border-t border-border bg-surface/50">
          <div className="marketing-section grid gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <ShelfSprite variant="success" sizes="96px" className="mb-5 h-24 w-24" />
              <p className="eyebrow mb-4">There is room on the shelf</p>
              <h2 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
                Ask for an invite
              </h2>
            </div>
            <div className="space-y-6">
              <p className="text-sm leading-relaxed text-muted">
                ShelfSprite is a personal project, and accounts are opened by hand. Leave your email
                and I will be in touch when there is a spot.
              </p>
              <WaitlistForm />
              <p className="text-xs leading-relaxed text-muted">
                You do not need a Goodreads account. You can start by adding books yourself or
                filling in the provided CSV template. ShelfSprite uses your own Anthropic API key
                for its AI features.
              </p>
            </div>
          </div>
        </section>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl space-y-4 px-5 py-8 text-xs leading-relaxed text-muted sm:px-8">
          <div className="flex flex-wrap justify-between gap-4">
            <p>Built by Chase Malcom. Made for readers.</p>
            <div className="flex gap-6">
              <a
                href="https://github.com/ccmalcom/shelfsprite"
                className="hover:text-text"
                rel="noreferrer"
              >
                Source on GitHub
              </a>
              <a href="/login" className="text-accent">
                Sign in
              </a>
            </div>
          </div>
          <p className="max-w-3xl">
            ShelfSprite is an independent project. It is not affiliated with, endorsed by, or
            sponsored by Goodreads or Amazon. Goodreads is a trademark of Amazon.com, Inc. Catalog
            metadata comes from Open Library and Google Books.
          </p>
        </div>
      </footer>
    </>
  );
}
