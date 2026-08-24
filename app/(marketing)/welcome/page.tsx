import type { Metadata } from 'next';
import Image from 'next/image';
import BrandLogo from '@/components/BrandLogo';
import ShelfSprite from '@/components/ShelfSprite';
import InviteHashRedirect from '@/components/InviteHashRedirect';
import WaitlistForm from './WaitlistForm';

/**
 * The public marketing page. Served at / for signed-out visitors through the rewrite in
 * utils/supabase/middleware.ts, and directly reachable at /welcome (the only way to see it in
 * local mode, where middleware no-ops and / renders the dashboard).
 *
 * canonical: '/' so crawlers that reach /welcome directly attribute the page to the URL people
 * actually share. The root layout already sets the global title; only the description is
 * overridden here so the tab reads the same everywhere. No Open Graph image: that is a separate
 * design task with its own asset pipeline.
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
    body: 'Goodreads has an export button. It gives you a CSV of every book you have shelved, every rating you have given, and the dates you read them. That file is the entire onboarding.',
  },
  {
    variant: 'discover' as const,
    title: 'Enrich',
    body: 'A row in that CSV is thin: a title, an author, a number. ShelfSprite goes out to Open Library and Google Books and fills in what is missing, subject headings, publication year, page count, the details that make one book comparable to another. Books it cannot pin down get labeled LOW and stay flagged, because a wrong match quietly poisoning your profile is worse than an obvious gap.',
  },
  {
    variant: 'success' as const,
    title: 'Recommend',
    body: 'Retrieval narrows the catalog to a set of candidates that actually exist. Claude ranks that set and writes the reason each book is on it. You get titles you can go and buy, with an explanation you can argue with.',
  },
];

export default function WelcomePage() {
  return (
    <>
      <InviteHashRedirect />

      <main className="mx-auto w-full max-w-3xl px-5 py-16 sm:px-6 sm:py-24">
        {/* 1. Hero */}
        <section className="flex flex-col gap-6">
          <BrandLogo priority sizes="208px" className="h-auto w-44 sm:w-52" />
          <h1 className="font-display text-3xl font-extrabold leading-tight tracking-tight text-text sm:text-5xl">
            Your reading history is a CSV file sitting in your downloads folder.
          </h1>
          <p className="max-w-2xl text-base text-muted sm:text-lg">
            ShelfSprite reads it, works out what you actually like, and hands back real books you
            have not read yet.
          </p>
          <WaitlistForm />
          <p className="font-mono text-xs text-faint">
            Have an invite?{' '}
            <a href="/login" className="text-accent hover:underline">
              Sign in
            </a>
          </p>
        </section>

        {/* 2. How it works */}
        <section className="mt-24 flex flex-col gap-10">
          <p className="font-mono text-xs uppercase tracking-widest text-faint">How it works</p>
          {STEPS.map((step) => (
            <div key={step.title} className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <ShelfSprite variant={step.variant} sizes="96px" className="h-24 w-24 shrink-0" />
              <div className="flex flex-col gap-2">
                <h3 className="font-display text-xl font-bold tracking-tight text-text">
                  {step.title}
                </h3>
                <p className="text-sm leading-relaxed text-muted sm:text-base">{step.body}</p>
              </div>
            </div>
          ))}
          <Image
            src="/marketing/how-it-works.png"
            alt="The ShelfSprite library view, listing imported books with their ratings and enriched metadata"
            width={1600}
            height={1000}
            sizes="(max-width: 768px) 100vw, 768px"
            className="h-auto w-full rounded-xl border border-border"
          />
        </section>

        {/* 3. The premise */}
        <section className="mt-24 flex flex-col gap-4">
          <h2 className="font-display text-2xl font-bold tracking-tight text-text sm:text-3xl">
            The books it recommends exist
          </h2>
          <p className="text-sm leading-relaxed text-muted sm:text-base">
            Ask a chatbot for book recommendations and some of what comes back will not exist. The
            title is plausible, the author is plausible, and there is no such book. You do not find
            out until you go looking for it.
          </p>
          <p className="text-sm leading-relaxed text-muted sm:text-base">
            ShelfSprite is built so that cannot happen. Recommendations come out of two stages. The
            first is ordinary deterministic retrieval against a real catalog, and everything it
            returns provably exists. Only then does Claude see anything, and its job is narrow: put
            that set in order and say why. It cannot invent a title, because it is never asked for
            one.
          </p>
          <p className="text-sm leading-relaxed text-text sm:text-base">
            The model is a critic here, not an author.
          </p>
        </section>

        {/* 4. Taste profile */}
        <section className="mt-24 flex flex-col gap-4">
          <h2 className="font-display text-2xl font-bold tracking-tight text-text sm:text-3xl">
            A profile built from evidence
          </h2>
          <p className="text-sm leading-relaxed text-muted sm:text-base">
            A five star rating tells you almost nothing on its own, because the person who reads
            only airport thrillers and the person who reads only Woolf both hand out fives, and
            never for the same reason.
          </p>
          <p className="text-sm leading-relaxed text-muted sm:text-base">
            ShelfSprite sorts your ratings into tiers and looks for what the books in each tier
            share once they have been enriched: subject, era, length, how far they sit from the
            middle of the catalog. The result is a profile that can say something more specific than
            &ldquo;likes literary fiction.&rdquo;
          </p>
          <p className="text-sm leading-relaxed text-muted sm:text-base">
            Reviews outrank all of it. Once you write down why a book landed, that sentence is
            better evidence than any amount of pattern matching over metadata, and the profile
            weights it accordingly.
          </p>
          <Image
            src="/marketing/taste-profile.png"
            alt="A ShelfSprite taste profile, showing claims about a reader with the books that support each one"
            width={1600}
            height={1000}
            sizes="(max-width: 768px) 100vw, 768px"
            className="mt-2 h-auto w-full rounded-xl border border-border"
          />
        </section>

        {/* 5. Waitlist CTA */}
        <section className="mt-24 flex flex-col gap-4">
          <h2 className="font-display text-2xl font-bold tracking-tight text-text sm:text-3xl">
            Ask for an invite
          </h2>
          <p className="max-w-2xl text-sm leading-relaxed text-muted sm:text-base">
            ShelfSprite is invite only. It started as a personal project, and it is still small
            enough that I hand out every account myself, so the waitlist is an actual list rather
            than a marketing device. Leave your email and I will get to it.
          </p>
          <WaitlistForm />
        </section>

        {/* 6. Footer */}
        <footer className="mt-24 border-t border-border pt-6 font-mono text-xs text-faint">
          Built by Chase Malcom.{' '}
          <a
            href="https://github.com/ccmalcom/shelfsprite"
            className="text-accent hover:underline"
            rel="noreferrer"
          >
            Source on GitHub
          </a>
          . Have an invite?{' '}
          <a href="/login" className="text-accent hover:underline">
            Sign in
          </a>
          .
        </footer>
      </main>
    </>
  );
}
