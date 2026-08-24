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
    body: 'Export from Goodreads or StoryGraph and drop the file in. That is the whole of onboarding, and it is the only thing ShelfSprite asks you to do by hand.',
  },
  {
    variant: 'discover' as const,
    title: 'Enrich',
    body: 'A row in that file is thin: a title, an author, a number. ShelfSprite fills in the rest from Open Library and Google Books, so that one book can be compared to another. Anything it cannot pin down is labelled LOW and stays flagged.',
  },
  {
    variant: 'success' as const,
    title: 'Recommend',
    body: 'Retrieval narrows the catalog to candidates that actually exist. Claude ranks that set and writes the reason each book is on it.',
  },
];

export default function WelcomePage() {
  return (
    <>
      <InviteHashRedirect />

      <main>
        {/* ── Hero ─────────────────────────────────────────────────────────────
            Asymmetric two-column: the argument on the left, the artifact on the
            right. The artifact IS the product shot — a CSV row becoming a
            catalog record — so the fold shows the mechanism, not a mood. */}
        <section className="mx-auto w-full max-w-6xl px-5 pb-20 pt-14 sm:px-8 sm:pb-28 sm:pt-20">
          <BrandLogo priority sizes="208px" className="mb-12 h-auto w-40 sm:mb-16 sm:w-48" />

          <div className="grid items-start gap-12 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
            <div className="flex flex-col gap-6">
              <h1 className="max-w-[15ch] text-balance font-display text-[2.5rem] font-extrabold leading-[1.05] tracking-tight text-text sm:text-6xl">
                Finding your next book shouldn&apos;t be this hard.
              </h1>
              <p className="max-w-[58ch] text-pretty text-lg leading-relaxed text-muted">
                Goodreads surfaces what&apos;s popular. A chatbot will invent a title that
                doesn&apos;t exist. ShelfSprite builds a taste profile from what you actually rated
                and recommends real books that match it — no popularity contest, nothing made up.
              </p>

              <div className="mt-2 max-w-md">
                <WaitlistForm />
              </div>

              <p className="font-mono text-xs text-faint">
                Have an invite?{' '}
                <a
                  href="/login"
                  className="rounded text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Sign in
                </a>
              </p>
            </div>

            <ResolveArtifact />
          </div>
        </section>

        {/* ── The three moves ──────────────────────────────────────────────────
            A genuine ordered sequence, so it is numbered on purpose rather than
            decorated with a kicker. Sprites carry the personality. */}
        <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
          <ol className="grid gap-12 sm:grid-cols-3 sm:gap-8">
            {STEPS.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-4">
                <ShelfSprite variant={step.variant} sizes="112px" className="h-20 w-20" />
                <div className="flex items-baseline gap-3">
                  <span className="font-mono text-xs text-accent">{i + 1}</span>
                  <h2 className="font-display text-xl font-bold tracking-tight text-text">
                    {step.title}
                  </h2>
                </div>
                <p className="max-w-[46ch] text-pretty text-[0.9375rem] leading-relaxed text-muted">
                  {step.body}
                </p>
              </li>
            ))}
          </ol>

          {/* Capped at the asset's own 850px: displaying a screenshot wider than it was
              captured upscales it and the UI goes soft. */}
          <figure className="mx-auto mt-14 max-w-[850px]">
            <Image
              src="/marketing/library.png"
              alt="The ShelfSprite library, listing imported books with their covers, half-star ratings and shelf counts"
              width={850}
              height={870}
              sizes="(max-width: 850px) 100vw, 850px"
              className="h-auto w-full rounded-xl border border-border"
            />
            <figcaption className="mt-3 font-mono text-xs text-faint">
              Sixteen rated books after an import, enriched and matched.
            </figcaption>
          </figure>
        </section>

        {/* ── The premise ──────────────────────────────────────────────────────
            The one real differentiator, so it gets the only contrasting band on
            the page and the page's single pull quote. */}
        <section className="border-y border-border bg-surface">
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
              <h2 className="max-w-[18ch] text-balance font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl">
                The books it recommends exist
              </h2>
              <div className="flex flex-col gap-5">
                <p className="max-w-[62ch] text-pretty leading-relaxed text-muted">
                  Ask a chatbot for book recommendations and some of what comes back will not exist.
                  The title is plausible, the author is plausible, and there is no such book. You do
                  not find out until you go looking for it.
                </p>
                <p className="max-w-[62ch] text-pretty leading-relaxed text-muted">
                  ShelfSprite is built so that cannot happen. Recommendations come out of two
                  stages. The first is ordinary deterministic retrieval against a real catalog, and
                  everything it returns provably exists. Only then does Claude see anything, and its
                  job is narrow: put that set in order and say why. It cannot invent a title,
                  because it is never asked for one.
                </p>
                <p className="max-w-[24ch] text-balance font-display text-2xl font-bold leading-snug tracking-tight text-text">
                  The model is a critic here, not an author.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── Taste profile ────────────────────────────────────────────────────*/}
        <section className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
            <h2 className="max-w-[18ch] text-balance font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl">
              A profile built from evidence
            </h2>
            <div className="flex flex-col gap-5">
              <p className="max-w-[62ch] text-pretty leading-relaxed text-muted">
                A five star rating tells you almost nothing on its own, because the person who reads
                only airport thrillers and the person who reads only Woolf both hand out fives, and
                never for the same reason.
              </p>
              <p className="max-w-[62ch] text-pretty leading-relaxed text-muted">
                ShelfSprite sorts your ratings into tiers and looks for what the books in each tier
                share once they have been enriched: subject, era, length, how far they sit from the
                middle of the catalog. Every claim it makes carries the books it is based on, so you
                can disagree with it in one click.
              </p>
              <p className="max-w-[62ch] text-pretty leading-relaxed text-muted">
                Reviews outrank all of it. Once you write down why a book landed, that sentence is
                better evidence than any amount of pattern matching over metadata, and the profile
                weights it accordingly.
              </p>
            </div>
          </div>

          <figure className="mx-auto mt-14 max-w-[850px]">
            <Image
              src="/marketing/taste-profile.png"
              alt="A ShelfSprite taste profile: each trait states a claim about the reader, with the books offered as evidence and as contrast"
              width={850}
              height={575}
              sizes="(max-width: 850px) 100vw, 850px"
              className="h-auto w-full rounded-xl border border-border"
            />
            <figcaption className="mt-3 font-mono text-xs text-faint">
              Every claim shows its evidence, and can be confirmed, rejected or downweighted.
            </figcaption>
          </figure>
        </section>

        {/* ── Waitlist ─────────────────────────────────────────────────────────*/}
        <section className="border-t border-border">
          <div className="mx-auto w-full max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
              <h2 className="max-w-[14ch] text-balance font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl">
                Ask for an invite
              </h2>
              <div className="flex flex-col gap-6">
                <p className="max-w-[62ch] text-pretty leading-relaxed text-muted">
                  ShelfSprite is invite only. It started as a personal project, and it is still
                  small enough that I hand out every account myself, so the waitlist is an actual
                  list rather than a marketing device. Leave your email and I will get to it.
                </p>
                <div className="max-w-md">
                  <WaitlistForm />
                </div>
                <p className="max-w-[62ch] text-pretty text-sm leading-relaxed text-faint">
                  You do not need a Goodreads account. A StoryGraph export works, so does a blank
                  template you fill in yourself, and you can skip the file entirely and add books by
                  hand.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Outside <main> on purpose: a <footer> nested inside main/section/article does NOT map
          to the contentinfo landmark, so screen-reader users lose the footer landmark entirely. */}
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-10 font-mono text-xs leading-relaxed text-faint sm:px-8">
          <p>
            Built by Chase Malcom.{' '}
            <a
              href="https://github.com/ccmalcom/shelfsprite"
              className="rounded text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              rel="noreferrer"
            >
              Source on GitHub
            </a>
            . Have an invite?{' '}
            <a
              href="/login"
              className="rounded text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Sign in
            </a>
            .
          </p>
          <p className="max-w-[70ch]">
            ShelfSprite is an independent project. It is not affiliated with, endorsed by, or
            sponsored by Goodreads or Amazon. Goodreads is a trademark of Amazon.com, Inc. Catalog
            metadata comes from Open Library and Google Books.
          </p>
        </div>
      </footer>
    </>
  );
}
