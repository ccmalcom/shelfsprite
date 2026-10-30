# ShelfSprite

ShelfSprite is a book recommendation app for people who keep track of what they read. You bring
your reading history, ShelfSprite matches each book to real catalog records, builds a taste profile
from how you rated them, and recommends books that actually exist, each with a reason that points
back to your own shelves.

A hosted instance runs at [shelfsprite.app](https://shelfsprite.app). It is invite-only for now:
visitors can ask for an invite on the home page, and accounts are opened by hand. The AI features
run on your own Anthropic API key, which you add during setup.

ShelfSprite is an independent project. It is not affiliated with, endorsed by, or sponsored by
Goodreads, Amazon, or The StoryGraph. Catalog metadata comes from Open Library and Google Books.

## What it does

### Getting your books in

The quickest start is an export from another reading tracker. A Goodreads export (My Books ›
Import/Export) or a StoryGraph export (Manage Account › Export) is recognized automatically, as is
a ShelfSprite backup. Any other CSV can be mapped column by column, and a blank template is
available at [`public/shelfsprite-template.csv`](public/shelfsprite-template.csv).

Readers without an export can start in three other ways: rate a grid of well-known books, paste a
list of titles copied from anywhere (notes, or a Kindle, Audible or Libby library page), or search
and add books one at a time. These can be combined, and books can be added the same ways later.

Importing is a one-time seeding step. Re-importing never overwrites a rating or review you have
changed inside ShelfSprite. ShelfSprite does not scrape Goodreads or call its API.

### Matching books to the catalog

Every book is matched against Open Library and Google Books to fill in covers, subjects, page
counts and identifiers. Each match carries a confidence label of high, medium or low. Ambiguous
matches stay low rather than being guessed, and the library shows how many need a check so you can
pick the right edition or record yourself. Matching runs as a background job, so a large library
keeps going after you close the page.

### Taste profile

The profile is built from your ratings and the metadata of the books you rated, grouped by how
much you liked them. Reviews you write in ShelfSprite count as direct evidence and outweigh what is
inferred from metadata. The result is a set of traits, each citing books that support it and books
that cut against it. You can confirm a trait, reject it, tell ShelfSprite to weigh it less, or
reword it. You can also write standing instructions in your own words (for example, "no series
I'd have to start in the middle of") that steer both the profile and recommendations.

The profile page also shows a reader archetype, your rating distribution and a genre breakdown.
The home page keeps your current reads, a preview of your to-read shelf and a summary of the year,
and you can set yearly reading goals in Settings.

### Recommendations

Recommendations arrive as a deck you swipe through. A book can be saved to your to-read shelf,
marked as already read (with an optional rating and review), or skipped with a reason such as
"wrong genre", which ShelfSprite takes into account in later rounds. Any book in your library also
has a "more like this" view, and the Discover page takes a plain-language request such as "a quiet
literary novel like Gilead, but shorter" and returns matching catalog books with reasons.

### Library

The library holds four shelves: read, currently reading, to-read and did not finish. Ratings use
half stars from 0.5 to 5. Each shelf can be searched, sorted and filtered, and unrated books can be
stepped through one at a time to rate them.

### Movies and TV (ScreenSprite)

ScreenSprite is an optional second section for films and shows, turned on per account in Settings.
It reads a Letterboxd export (the ZIP file Letterboxd provides), matches titles against Wikidata,
Wikipedia and TVmaze, and gives screen titles their own library, profile and recommendations.
Turning it off removes the traits that screen titles contributed to your profile; the titles
themselves are kept in case you turn it back on.

### Your data

Settings has a backup download as CSV (which ShelfSprite can re-import) or JSON (a complete
backup), a running total of what ShelfSprite has spent on your Anthropic key this month, and an
option to delete all of your data, including your saved key. Narrower resets clear only your
profile, only your books, or only your screen library.

## How recommendations work

Recommendation is a two-stage process, and the split is deliberate. In the first stage, ordinary
code searches Open Library and Google Books for candidates based on your profile, then removes
books you already own, duplicate editions, unreleased books, and anything your instructions or
past skips rule out. In the second stage, Claude ranks that bounded set and writes the reason for
each pick. Claude can suggest search terms and choose among candidates, but it cannot add a title
to the results. Every book it returns is checked against the candidate set first, so a
recommendation always refers to a real catalog record.

```text
reading history -> import -> catalog matching -> taste profile -> candidate search -> Claude rerank
                                  |                                       |
                       Open Library, Google Books              Open Library, Google Books
```

## Privacy and security

These notes describe the code in this repository. Anyone running their own instance is
responsible for their own deployment.

- **Your Anthropic key.** A key you save in ShelfSprite is encrypted with AES-256-GCM before it is
  stored and is decrypted only on the server when a request needs it. It is never sent back to the
  browser. Charges for AI features go to that key.
- **Separation between accounts.** Every row of user data is scoped to the signed-in user's
  Supabase ID, and every route that reads or writes data enforces that scope. Row-level security
  is enabled on every table so the Supabase Data API cannot reach application data; the app
  itself connects to Postgres directly.
- **Authentication fails closed.** If the deployment's Supabase settings are incomplete, the app
  refuses requests with a configuration error instead of falling back to an unauthenticated mode.
  The local single-user mode described below has to be switched on explicitly and is ignored in
  production builds.
- **What leaves the server.** Book titles, authors and identifiers are sent to Open Library and
  Google Books for matching; screen titles go to Wikidata, Wikipedia and TVmaze. Prompts sent to
  Anthropic contain your books, ratings, reviews and profile, because that is what the profile and
  reranking are built from. The hosted instance uses Vercel Web Analytics for page view counts.

## Running your own instance

ShelfSprite is a single Next.js application. Pages and the API live in the same app, so there is
no separate backend or worker to deploy.

You will need:

- Node.js 22
- A PostgreSQL database. Any Postgres works for local use; the hosted setup uses Supabase.
- An Anthropic API key
- A Google Books API key (optional, but it raises Google's anonymous rate limits)

### Local, single user

Local mode skips sign-in and serves every request as one built-in user who is also the
administrator. It is meant for development and for running ShelfSprite only for yourself.

```bash
git clone https://github.com/ccmalcom/shelfsprite.git
cd shelfsprite
npm install
cp .env.example .env
```

In `.env`, leave every Supabase variable unset and set:

- `ALLOW_LOCAL_AUTH=true`
- `DATABASE_URL`, a plain `postgresql://` connection string
- `ANTHROPIC_API_KEY`, used whenever a user has not saved a key of their own. If you would rather
  save the key through the setup screen, set `ENCRYPTION_KEY` instead (32 random bytes, base64
  encoded, for example from `openssl rand -base64 32`).
- `CRON_SECRET`, any random string. Catalog matching works in chunks of about four minutes, and
  each chunk starts the next with this secret, so without it a large library stops after the first
  chunk.

Then create the schema and start the app:

```bash
npm run db:migrate
npm run dev
```

The app opens at <http://localhost:3000>. In local mode the root URL goes straight to the app; the
public landing page is at `/welcome`.

### Hosted, multiple users

The production setup is Vercel for the app and Supabase for both Postgres and sign-in. Other Node
hosts may work but have not been tested; see the note on scheduled jobs below.

Set these in the Vercel project for every environment that should work:

| Variable                                | Required | Purpose                                                                     |
| --------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                          | Yes      | Supabase session pooler connection string                                   |
| `SUPABASE_URL`                          | Yes      | Supabase project URL, used for token verification and admin calls           |
| `NEXT_PUBLIC_SUPABASE_URL`              | Yes      | The same project URL, for the browser client                                |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`  | Yes      | Supabase publishable key                                                    |
| `SUPABASE_SECRET_KEY`                   | Yes      | Supabase secret key, server only, used to send invites and remove users     |
| `ENCRYPTION_KEY`                        | Yes      | 32-byte base64 key that encrypts saved Anthropic keys                       |
| `ADMIN_EMAILS`                          | Yes      | Comma-separated list of accounts that can use the admin console             |
| `FRONTEND_URL`                          | Yes      | The app's public origin, with no trailing slash; invite links return here   |
| `CRON_SECRET`                           | Yes      | Shared secret for the scheduled cleanup job and background job continuation |
| `ANTHROPIC_API_KEY`                     | No       | Server-wide fallback for users who have not saved a key                     |
| `GOOGLE_BOOKS_API_KEY`                  | No       | Google Books key shared by all users                                        |
| `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` | No       | Let admins turn in-app feedback into GitHub issues                          |

[`docs/hosting.md`](docs/hosting.md) has the complete list, including model overrides, usage
warnings and feedback settings.

A few parts of a hosted setup live outside the code:

- **Invites.** Add `<FRONTEND_URL>/auth/callback` to Supabase's allowed redirect URLs (Auth › URL
  Configuration). Without it, invite links land on Supabase's default site URL and the new user
  cannot finish signing up.
- **Migrations.** Schema changes are applied by hand with `npm run db:migrate` against the
  production `DATABASE_URL`, never during a build. When a pull request adds a migration, run it
  before merging, because merging deploys immediately. On an empty database, the same command
  creates the whole schema.
- **Scheduled jobs.** `vercel.json` schedules a nightly cleanup at `/api/enrich/janitor` that
  repairs stalled matching jobs and prunes old catalog cache. Vercel runs it only on production
  deployments and authenticates it with `CRON_SECRET`. On another host, call that route on a
  schedule yourself with an `Authorization: Bearer <CRON_SECRET>` header.
- **Rotating `ENCRYPTION_KEY`.** Changing the key alone makes every saved Anthropic key
  unreadable. Re-encrypt them first with `npm run db:rotate-encryption-key`; the steps are in
  [`docs/hosting.md`](docs/hosting.md#rotating-encryption_key).

## Development

All commands run from the repository root.

```bash
npm run dev           # start the app
npm run test:server   # Vitest: lib/server/** and app/api/**
npm test              # Jest: everything else
npm run type-check
npm run lint
npm run format:check
npm run build         # catches Next.js config and prerender failures the other checks miss
```

The two test runners cover separate parts of the code, so a complete check runs both, and
`npm run build` as well. Continuous integration runs the same commands on every pull request, plus
a dependency audit.

### Where things are

- `app/` holds pages and the API route handlers under `app/api/`.
- `components/` holds application and shared UI components.
- `lib/api.ts` is the typed browser client for the API.
- `lib/server/` holds server code: authentication, database access, catalog matching, profile
  building, recommendations, import and export, and administration.
- `drizzle/` holds generated migration SQL; `lib/server/schema.ts` is the schema it is generated
  from.
- `proxy.ts` is the page middleware. API routes handle their own authentication.

### Further reading

- [`docs/architecture.md`](docs/architecture.md) maps the server modules and records the product
  decisions that the code depends on.
- [`docs/frontend.md`](docs/frontend.md) covers routes, components and UI conventions.
- [`docs/conventions.md`](docs/conventions.md) lists repository conventions and data invariants.
- [`docs/hosting.md`](docs/hosting.md) covers deployment, configuration and migrations.
- [`CLAUDE.md`](CLAUDE.md) is written for AI coding assistants but doubles as a short list of the
  rules that are easiest to break without noticing.

## License

ShelfSprite is licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`). The full text is in [`LICENSE`](LICENSE).

You may run, study, change and share the code. If you run a modified version that other people use
over a network, the AGPL requires you to offer those users the source code of your version under
the same license.
