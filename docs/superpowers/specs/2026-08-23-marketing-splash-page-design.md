# Marketing splash page + invite waitlist — design

**Date:** 2026-08-23
**Status:** approved in chat, ready for implementation planning
**Branch:** `marketing-splash` (to be created)

Today an unauthenticated visitor to `shelfsprite.app` is redirected straight to `/login` and sees
a password form for an invite-only product they have no account for. There is nothing on the
public internet that says what ShelfSprite is.

This spec adds a public marketing page served at `/`, an invite-request waitlist backed by a new
table and a public POST endpoint, and an admin surface that turns a pending request into a real
invite through the existing `createInvite` path.

---

## 1. Preconditions (verified 2026-08-23 against source, not assumed)

| Precondition | Status | How it was verified |
|---|---|---|
| `/` is the authed dashboard | ✅ | `app/(main)/page.tsx`; there is no `app/page.tsx` |
| Unauthenticated page requests redirect to `/login` | ✅ | `utils/supabase/middleware.ts` — `PUBLIC_PREFIXES = ['/login', '/auth']`, else `NextResponse.redirect` |
| `proxy.ts` already excludes `/api` | ✅ | matcher negative lookahead includes `api`; no matcher change needed |
| Middleware no-ops in local mode | ✅ | `updateSession` returns early when `NEXT_PUBLIC_SUPABASE_URL`/`_PUBLISHABLE_KEY` are absent |
| `withApi` supports unauthenticated routes | ✅ | `WithApiOpts.requireAuth`; `app/api/admin/me/route.ts` passes `{ requireAuth: false }` |
| `ApiError` is available for the 429 | ✅ | `lib/server/errors.ts` exports `class ApiError`; `withApi` maps it to `{detail}` |
| `uniqueIndex` is already imported in `schema.ts` | ✅ | import block at the top; used 7 times |
| `schema.ts` header forbids hand-edits | ⚠️ | file header says it is `drizzle-kit pull` output. See §4.1 — this is a real conflict with the task and is addressed there |
| `withApi`'s first argument is the route path string | ✅ | `withApi('/api/admin/me', …)` |
| A Postgres rate limiter already exists | ✅ | `lib/server/ratelimit.ts` exports `checkRateLimit` + `RATE_LIMITS`; used by 5 routes |
| `rate_limits` table exists and is in the pglite helper | ✅ | `schema.ts` `rateLimits`; `helpers/pglite.ts:28` `create table rate_limits` |
| `createInvite` exists and takes `{ email, invitedBy }` | ✅ | `lib/server/invites.ts:64` |
| `invites` table + admin roster exist | ✅ | `schema.ts:313`; `listRoster`; `app/api/admin/invite/route.ts` |
| Admin page is a client tab switcher | ✅ | `app/(main)/admin/page.tsx:41` — `useState<'users'\|'usage'\|'feedback'\|'system'>`; tabs live in `components/admin/*Tab.tsx` |
| `inviteCallbackRedirect` is dependency-free | ✅ | `lib/authRedirect.ts` has zero imports |
| The invite-hash rescue depends on the `/` → `/login` redirect | ✅ | `lib/authRedirect.ts` header comment and `app/login/page.tsx`'s `useEffect` |
| pglite helper hand-writes every `create table` | ✅ | `helpers/pglite.ts` — 17 hand-written statements; a new table must be added there |
| Vitest owns only `lib/server/**` and `app/api/**` | ✅ | `vitest.config.ts` `include` (note: `*.test.ts`, not `.tsx`) |
| Jest ignores exactly those two paths | ✅ | `jest.config.js` `testPathIgnorePatterns` |
| `lib/api.ts` attaches a Supabase session token to every call | ✅ | file header + `authHeaders`; therefore unusable from the public page |
| UI primitives available | ✅ | `components/ui/index.ts` — `Button, Input, Field, Card, Badge, Spinner, …` |
| Brand assets exist | ✅ | `components/BrandLogo.tsx`; `components/ShelfSprite.tsx` with `analyze \| discover \| sleep \| success` |
| Root metadata is set in the root layout | ✅ | `app/layout.tsx:27` |

**Symbols, not line numbers.** Line references locate a region; find code by symbol name.

---

## 2. Scope

**In scope.** A public marketing page rendered at `/` via middleware rewrite, an `invite_requests`
table, a public `POST /api/invite-requests`, three admin routes, an admin tab for triaging
requests, product screenshots captured from seeded fake data, and tests across both runners.

**Out of scope.**

- Self-serve signup. The product stays invite-only; the waitlist is a queue, not a funnel.
- Email notification on new requests. Requests are pulled from the admin tab, not pushed.
- Any change to the authenticated app's routing, navigation, or layout.
- A public pricing, docs, blog, or about page.
- Analytics or tracking of any kind on the marketing page.

---

## 3. Routing

### 3.1 The rewrite

New route group `app/(marketing)/` containing `layout.tsx` and `welcome/page.tsx`. The group's
layout is deliberately minimal: no `NavBar`, `BottomNav`, `LibraryGate`, `ReprofileBanner`, or
`FeedbackLauncher`, and no `Providers` wrapper, because none of those work without a session.

In `utils/supabase/middleware.ts`:

1. Add `/welcome` to `PUBLIC_PREFIXES`.
2. Before the existing redirect branch, add: if there is no user and `path === '/'` exactly, return
   `NextResponse.rewrite(new URL('/welcome', request.url))`.
3. Every other unauthenticated page path keeps its current `NextResponse.redirect` to `/login`.
4. The authenticated branches are untouched: a signed-in user still gets `app/(main)/page.tsx` at
   `/`, and is still bounced from `/login` to `/`.

The rewrite must be built on the cookie-carrying response, not a bare `NextResponse` — the
existing `supabaseResponse` cookie-propagation contract still applies to the rewritten request, or
a refreshed token gets dropped.

`proxy.ts` is not modified. Its matcher already excludes `/api`, which CLAUDE.md documents as
load-bearing.

### 3.2 The invite-hash trap

This is the highest-risk part of the change and the reason `/welcome` is not just a new page.

`lib/authRedirect.ts` exists because a misconfigured Supabase invite link delivers its session
tokens in the URL hash at the bare app root. Today middleware redirects that request to `/login`,
whose `useEffect` calls `inviteCallbackRedirect(window.location.hash)` and forwards to
`/auth/callback`, where the tokens are actually consumed. The URL fragment survives the redirect,
so the rescue works.

A rewrite keeps the URL at `/`. The `/login` page never loads, so the rescue never fires, and an
invited user lands on a marketing page while their one-time invite token sits unused in the
address bar. The failure is silent: no error, no network failure, just a stranger's landing page.

**Requirement.** `app/(marketing)/welcome/page.tsx` must mount a client component that runs the
same `inviteCallbackRedirect(window.location.hash)` effect as `app/login/page.tsx`. Extract that
effect into a shared `components/InviteHashRedirect.tsx` client component and use it in both
places rather than copying the `useEffect`. `lib/authRedirect.ts`'s header comment describes the
`/login` bounce as the mechanism; update it to describe both entry points.

This behavior gets a dedicated test (§8).

### 3.3 Canonicalization and metadata

`/welcome` stays directly reachable — it is the only way to see the page in local mode, where
middleware no-ops and `/` renders the dashboard. It exports:

```ts
export const metadata: Metadata = {
  description:
    'Import your Goodreads library, get a taste profile built from what you actually rated, ' +
    'and get recommendations for real books that exist.',
  alternates: { canonical: '/' },
};
```

so crawlers that reach `/welcome` directly attribute the page to `/`. The root layout already sets
a global `title` and `description`; this page overrides the description only, and keeps the title
as-is so the tab reads the same everywhere.

No Open Graph image. It is a separate design task with its own asset pipeline and is out of scope.

---

## 4. Data model

New table in `lib/server/schema.ts`:

```ts
export const inviteRequests = pgTable(
  'invite_requests',
  {
    id: serial().primaryKey().notNull(),
    email: varchar().notNull(),
    status: varchar().notNull(),           // 'pending' | 'approved' | 'declined'
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    reviewedAt: timestamp('reviewed_at', { mode: 'string' }),
    reviewedBy: varchar('reviewed_by'),
  },
  (table) => [uniqueIndex('ux_invite_requests_email').using('btree', table.email.asc().nullsLast().op('text_ops'))]
);
```

Notes that must survive into the implementation:

- **Email is stored lowercased and trimmed.** The unique index is on the raw column, so
  normalization happens in `lib/server/inviteRequests.ts` before every insert and lookup. Do not
  rely on a functional index.
- **`status` is a plain varchar, not an enum**, matching `invites.status` and `feedback.status`.
- **This table is intentionally not tenant-scoped.** Every other user-owned table carries a
  `user_id` that forms the tenancy boundary CLAUDE.md requires. Invite requests are pre-account
  data submitted by people who have no `sub` yet, so there is nothing to scope them to. They are
  readable only by admins. This is the one deliberate exception and should not be "fixed."
- **`reviewedBy`** holds the reviewing admin's Supabase `sub`.

### 4.1 The `schema.ts` header says not to hand-edit. Read this before touching it.

`lib/server/schema.ts` opens with a comment saying it was produced by `drizzle-kit pull` against
the Alembic-owned dev database and that column shapes must never be edited by hand, with
re-pulling and diffing given as the alternative. Taken literally that blocks this task, and an
implementer who follows it will run `drizzle-kit pull` and overwrite the file against whatever
state the dev database happens to be in.

Do not do that. The header is a guard against hand-editing the shape of tables that were
introspected from a database Alembic owns, so that the checked-in file cannot silently drift from
the real column types. Adding a brand new table that ShelfSprite itself owns, and that no other
system has ever created, is a different operation: there is nothing to drift from, because the
table does not exist anywhere yet.

So: hand-add `inviteRequests` to `schema.ts`, leave every existing table untouched, and never run
`drizzle-kit pull` as part of this change.

### 4.2 Migration

Generate with `drizzle-kit generate`, read the emitted SQL by hand, then apply through the
workflow in `docs/hosting.md`.

Per CLAUDE.md: `drizzle-kit generate` never reads a live database, so a clean generate is not
evidence that production matches. After applying, verify the real column set, nullability, and
defaults with `information_schema.columns`, not with `schema.ts`.

Add a matching `create table invite_requests (…)` to `lib/server/__tests__/helpers/pglite.ts`.
That helper hand-writes all 17 existing tables; a new table that is missing there fails every
seeded test that touches it.

---

## 5. Public endpoint

`app/api/invite-requests/route.ts`, `POST` only:

```ts
export const POST = withApi('/api/invite-requests', handler, { requireAuth: false });
```

Domain logic lives in a new `lib/server/inviteRequests.ts`; the route stays thin, matching the
rest of `lib/server/`.

### 5.1 Request

```ts
z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  website: z.string().optional(),   // honeypot; real users never see this field
})
```

### 5.2 Behavior, in order

1. **Honeypot.** If `website` is a non-empty string, return the success response and write
   nothing. No log, no row, no rate-limit consumption.
2. **Rate limit.** Call the existing `checkRateLimit(db, { key, limit, windowSeconds })` with a new
   entry added to the exported `RATE_LIMITS` map in `lib/server/ratelimit.ts`:
   `inviteRequest: { limit: 5, windowSeconds: 3600 }`.
3. **Upsert-by-email.** If a row with that email already exists in any status, return the success
   response without modifying it. Otherwise insert with `status: 'pending'`.
4. **Respond.** Always `{ ok: true }` with status 200.

### 5.3 Two decisions that must be stated in code comments

**The rate-limit key is IP-derived, which is new for this codebase.** Every existing entry in
`RATE_LIMITS` is keyed per authenticated user. This route has no user. Build the key as
`invite_request:<ip>` where `ip` is the first comma-separated entry of `x-forwarded-for`, trimmed.
When the header is absent, fall back to a single constant bucket (`invite_request:unknown`) rather
than skipping the limit. That fails closed: header-less traffic shares one bucket instead of
bypassing the limiter entirely.

**Do not use `rateLimitExceededResponse`.** That helper returns
`{error: "Rate limit exceeded: N per M minute"}` instead of the `{detail: …}` shape every other
route uses, and its comment says not to "fix" it. That is correct for the five routes it serves,
which exist to be byte-compatible with the retired Python app's SlowAPI handler. This route has no
Python ancestor, so it should throw `ApiError(429)` and get the normal `{detail}` shape. Copying
the neighbouring routes here would inherit a compatibility quirk for no reason.

### 5.4 Why every outcome returns the same body

New request, duplicate request, and honeypot submission all return `{ ok: true }` / 200. A
distinguishable response would turn this endpoint into an oracle for "is this email already known
to ShelfSprite," which on an invite-only product leaks the user list. The only status codes that
differ are 422 (Zod rejected the email) and 429 (rate limited).

---

## 6. Admin

### 6.1 Routes

All three take `{ requireAdmin: true }`:

| Route | Method | Behavior |
|---|---|---|
| `/api/admin/invite-requests` | `GET` | List requests, newest first. Optional `?status=pending\|approved\|declined`. |
| `/api/admin/invite-requests/[id]/approve` | `POST` | Create the invite, then mark the row approved. |
| `/api/admin/invite-requests/[id]/decline` | `POST` | Mark the row declined. |

### 6.2 Approve is deliberately not transactional

Approve does, in this order:

1. `createInvite({ email: row.email, invitedBy: ctx.user.userId })`
2. On success, set `status: 'approved'`, `reviewedAt: now`, `reviewedBy: ctx.user.userId`.

These are **not** wrapped in one transaction, and that is the point. CLAUDE.md documents the
precedent: `createInvite` performs a GoTrue write that cannot be rolled back, which is exactly why
`createInvite` itself is not wrapped in a transaction while `backfillFromSupabase` is. The
irreversible remote call goes first and the local bookkeeping follows it.

If `createInvite` throws, the row stays `pending`, the error surfaces to the admin, and the action
is safely retryable. If it succeeds and the status update then fails, the admin sees the invite in
the roster and a still-pending request, which is a visible and harmless inconsistency they can
clear by approving again (`createInvite` already upserts on existing email).

Do not "harmonize" this with the transactional functions in `invites.ts`.

### 6.3 UI

New `components/admin/InviteRequestsTab.tsx`, wired into the existing tab union in
`app/(main)/admin/page.tsx` as `'requests'`. It lists email, submitted date, and status, with
Approve and Decline buttons on pending rows. Reuse `components/admin/Pagination.tsx` only if the
list is paginated server-side; otherwise skip it, since the expected volume is small.

Use `Badge` from `components/ui` for the per-row status, the way `FeedbackTab` does. Do not add a
pending-count badge to the tab button: no tab in the admin page carries a count today, and adding
one to a single tab is an inconsistency this change does not need.

---

## 7. The page

### 7.1 Structure

Server components throughout, except the two client islands: the waitlist form and
`InviteHashRedirect`.

| # | Section | Contents |
|---|---|---|
| 1 | Hero | `BrandLogo`, headline, subhead, waitlist form, "Have an invite? Sign in" link to `/login` |
| 2 | How it works | Three steps, one `ShelfSprite` mascot each (`analyze`, `discover`, `success`), plus a product screenshot |
| 3 | The premise | Why recommendations are real books, and how the two-stage pipeline enforces that |
| 4 | Taste profile | What an evidence-backed profile is, plus a screenshot |
| 5 | Waitlist CTA | Repeat form, invite-only framing |
| 6 | Footer | GitHub link, sign in, built-by line |

### 7.2 Constraints

- **No `lib/api.ts` and no `getSupabaseClient` on this page.** The API client attaches a Supabase
  session token to every request, which pulls the Supabase browser client into the marketing
  bundle for a page whose entire audience is signed out. The waitlist form calls
  `fetch('/api/invite-requests', …)` directly. `InviteHashRedirect` only needs
  `lib/authRedirect.ts`, which has no imports.
- Use the existing tokens and primitives: `bg-base`, `text-text`, `text-muted`, `border-border`,
  `font-display` for headings, `font-mono` for the small uppercase labels the app already uses,
  and `Button` / `Input` / `Field` from `components/ui`.
- `ShelfSprite` illustrations are decorative and already render with `alt=""` / `aria-hidden`. The
  adjacent copy must name what each step does, since the image will not.
- Responsive down to 360px. The page must not scroll horizontally at any width.
- Respect `prefers-reduced-motion`; `globals.css` already zeroes animation durations under it, so
  do not add motion that depends on JS timing to be legible.

### 7.3 Form states

Idle, submitting (disabled + `Spinner`), success, invalid email, rate limited, and network error.
Success replaces the form rather than sitting above it, so nobody submits twice.

Microcopy (button labels, validation text, state messages) stays conventional and functional. The
voice guidance in §7.4 applies to the prose, not to the controls.

### 7.4 Copy

Drafted per the `chase-writing-voice` skill and audited against its `ai-tells-checklist`. No em
dashes, plain diction, concrete anchor before the abstract claim, one landing sentence after a
build rather than stacked fragments.

**Hero**

> # Your reading history is a CSV file sitting in your downloads folder.
>
> ShelfSprite reads it, works out what you actually like, and hands back real books you have not
> read yet.

**How it works**

> ### Import
> Goodreads has an export button. It gives you a CSV of every book you have shelved, every rating
> you have given, and the dates you read them. That file is the entire onboarding.
>
> ### Enrich
> A row in that CSV is thin: a title, an author, a number. ShelfSprite goes out to Open Library
> and Google Books and fills in what is missing, subject headings, publication year, page count,
> the details that make one book comparable to another. Books it cannot pin down get labeled LOW
> and stay flagged, because a wrong match quietly poisoning your profile is worse than an obvious
> gap.
>
> ### Recommend
> Retrieval narrows the catalog to a set of candidates that actually exist. Claude ranks that set
> and writes the reason each book is on it. You get titles you can go and buy, with an explanation
> you can argue with.

**The premise**

> ## The books it recommends exist
>
> Ask a chatbot for book recommendations and some of what comes back will not exist. The title is
> plausible, the author is plausible, and there is no such book. You do not find out until you go
> looking for it.
>
> ShelfSprite is built so that cannot happen. Recommendations come out of two stages. The first is
> ordinary deterministic retrieval against a real catalog, and everything it returns provably
> exists. Only then does Claude see anything, and its job is narrow: put that set in order and say
> why. It cannot invent a title, because it is never asked for one.
>
> The model is a critic here, not an author.

**Taste profile**

> ## A profile built from evidence
>
> A five star rating tells you almost nothing on its own, because the person who reads only
> airport thrillers and the person who reads only Woolf both hand out fives, and never for the
> same reason.
>
> ShelfSprite sorts your ratings into tiers and looks for what the books in each tier share once
> they have been enriched: subject, era, length, how far they sit from the middle of the catalog.
> The result is a profile that can say something more specific than "likes literary fiction."
>
> Reviews outrank all of it. Once you write down why a book landed, that sentence is better
> evidence than any amount of pattern matching over metadata, and the profile weights it
> accordingly.

**Waitlist**

> ## Ask for an invite
>
> ShelfSprite is invite only. It started as a personal project, and it is still small enough that
> I hand out every account myself, so the waitlist is an actual list rather than a marketing
> device. Leave your email and I will get to it.

**Footer**

> Built by Chase Malcom. Source on GitHub. Have an invite? Sign in.

Copy is the part most worth rewriting by hand. Implementers should treat the text above as final
unless told otherwise, and should not paraphrase it.

---

## 8. Screenshots

Two images in `public/marketing/`: one for How it works, one for the taste profile.

**Not an implementation task.** They are captured against a throwaway local library seeded with
fictional books via the `isolated-local-env` skill, so no real reading history is published. An
implementer builds against placeholder images with the final intrinsic dimensions and does not
block on them.

Both are rendered through `next/image` with explicit `width`/`height` (no layout shift) and
descriptive `alt` text, since unlike the mascots these carry information.

---

## 9. Testing

### 9.1 Vitest — `lib/server/**` and `app/api/**`

`lib/server/__tests__/inviteRequests.test.ts`
- Insert normalizes email to lowercase and trims it.
- A second submission of the same email in any status inserts no second row.
- A second submission of the same email in different case is still treated as a duplicate.

`app/api/invite-requests/route.test.ts`
- Valid new email returns 200 `{ ok: true }` and writes exactly one row.
- Duplicate email returns 200 `{ ok: true }` and writes no second row.
- Honeypot filled returns 200 `{ ok: true }` and writes nothing.
- Malformed email returns 422.
- The 5th request in a window succeeds and the 6th returns 429 with a `{detail}` body, not the
  `{error}` shape.
- Two different `x-forwarded-for` values do not share a bucket.
- A missing `x-forwarded-for` still consumes a limit rather than bypassing it.

`app/api/admin/invite-requests/route.test.ts` and the approve/decline route tests
- Non-admin gets 403; unauthenticated gets 401.
- `GET` filters by status.
- Approve calls `createInvite` exactly once with the row's email and the caller's `userId`, then
  marks the row approved with `reviewedBy` set.
- When `createInvite` throws, the row is still `pending` and the response is an error. Use the
  existing `_setInviteUserForTests` seam in `invites.ts` rather than mocking the module.
- Decline marks declined without calling `createInvite`.

Extend `lib/server/__tests__/helpers/pglite.ts` with `create table invite_requests` first, or all
of the above fail on a missing relation.

### 9.2 Jest — everything else

`utils/supabase/__tests__/middleware.test.ts`
- No user + `/` → rewrite to `/welcome`, and the response is not a redirect.
- No user + `/library` → redirect to `/login` (unchanged).
- No user + `/welcome` → passes through, no redirect.
- Authenticated + `/` → no rewrite, dashboard renders.
- Authenticated + `/login` → redirect to `/` (unchanged).
- No Supabase env → no rewrite and no redirect for any path.

`components/__tests__/InviteHashRedirect.test.tsx` (jsdom docblock)
- An invite/recovery hash forwards to `/auth/callback` with the fragment preserved.
- An empty or unrelated hash does not navigate.

`app/(marketing)/__tests__/welcome.test.tsx` (jsdom docblock)
- All six sections render.
- The sign-in link points at `/login`.
- Form: success replaces the form; 422 shows an invalid-email message; 429 shows a rate-limited
  message; a network failure shows an error and leaves the form usable.
- The honeypot input is present and hidden from assistive technology.

Note `vitest.config.ts` includes `*.test.ts` only, so the `.tsx` component tests are unambiguously
Jest's, and `app/(marketing)/` is not in Jest's ignore list (only `app/api/` is).

### 9.3 Full gate

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

`npm run build` is mandatory. It is the only gate that catches Next segment-config and prerender
failures, and this change adds a route group and a rewrite.

### 9.4 Manual verification

Tests are not sufficient here; the rewrite and the invite-hash path both depend on real middleware
behavior. Against a running app:

1. Signed out, load `/`. The splash renders and the address bar still reads `/`.
2. Submit the form. Success state appears. Submit the same email again; still succeeds, no second
   row.
3. Signed in, load `/`. The dashboard renders, unchanged.
4. Signed out, load `/library`. Still redirects to `/login`.
5. Load `/` with a fake Supabase auth hash appended. It forwards to `/auth/callback`.
6. As admin, find the request in the new tab and approve it. Confirm the invite email is actually
   sent and the row flips to approved.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| The rewrite silently breaks invite links (§3.2) | `InviteHashRedirect` on the welcome page, shared with `/login`, plus a dedicated test and manual step 5 |
| Cookie refresh lost on the rewritten response | Build the rewrite from the existing cookie-carrying response, not a bare `NextResponse` |
| Public endpoint becomes a user-enumeration oracle | Identical response body for new, duplicate, and honeypot |
| Spam floods the table | Honeypot + IP rate limit; if it is actually hit, escalate to Vercel BotID, which was considered and deferred |
| Production schema drifts from `schema.ts` | Verify with `information_schema.columns` after applying, per CLAUDE.md |
| Missing pglite table breaks unrelated tests | Add `create table invite_requests` in the same change as the schema edit |
| Screenshots leak real library data | Captured only from a seeded throwaway library via `isolated-local-env` |
| Supabase client leaks into the public bundle | No `lib/api.ts` or `getSupabaseClient` imports under `app/(marketing)/` |

---

## 11. Decisions considered and rejected

- **Redirect `/` to `/welcome`** instead of rewriting. Rejected: the URL people share is
  `shelfsprite.app`, and a redirect means that is never what they land on.
- **Move the dashboard to `/home`** and give `/` to the splash. Rejected: touches `NavBar`,
  `BottomNav`, `LibraryGate`, the post-signin redirect, and every hardcoded `href="/"` for no gain
  over the rewrite.
- **Email notification instead of a table.** Rejected: no durable record, and it adds a mail
  provider dependency.
- **Cloudflare Turnstile or Vercel BotID.** Deferred, not rejected. The in-route protections are
  proportionate to a small personal site; revisit if spam actually arrives.
- **An optional "what do you read?" note field.** Rejected. One more thing to build, moderate, and
  display, for context that a one-line email request does not really need.
- **Product screenshots taken from the real library.** Rejected: publishes a real reading history.

---

## 12. Implementation ordering

Sequenced so each step is independently verifiable, and so the page can be built before the
screenshots exist.

1. Schema: `inviteRequests` in `schema.ts`, `drizzle-kit generate`, inspect SQL, add the pglite
   `create table`.
2. `lib/server/inviteRequests.ts` + its Vitest suite.
3. `RATE_LIMITS.inviteRequest` + public `POST /api/invite-requests` + route tests.
4. Admin routes + tests.
5. `InviteRequestsTab` + admin page wiring.
6. `InviteHashRedirect` extracted from `/login`, used in both places, with its test.
7. Middleware rewrite + `PUBLIC_PREFIXES` + middleware tests.
8. `app/(marketing)/` layout, welcome page, waitlist form, copy, placeholder images + page tests.
9. Screenshots swapped in (not an implementer task).
10. Full gate, then manual verification (§9.4).

Steps 1 through 8 are suitable for delegation. Step 9 and the §9.4 walkthrough are not.
