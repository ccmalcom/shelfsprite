# Marketing splash page + invite waitlist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. Most tasks here are written to be dispatched to Codex
> one task per dispatch — see **Codex dispatch notes** below.

**Goal:** Serve a public marketing page at `/` for signed-out visitors, collect invite requests
into a new `invite_requests` table through a public endpoint, and let an admin turn a pending
request into a real invite from the admin console.

**Architecture:** A middleware *rewrite* (not a redirect) sends the signed-out `/` request to a new
`app/(marketing)/welcome` route group, so the shared URL stays `shelfsprite.app`. A public
`POST /api/invite-requests` (honeypot + IP-keyed Postgres rate limit) writes rows that three
admin-gated routes list, approve, and decline. Approve calls the existing `createInvite`, which
performs the irreversible GoTrue write, and only then marks the row reviewed.

**Tech Stack:** Next.js 16 App Router, TypeScript, drizzle-orm + drizzle-kit, Zod 4, Tailwind,
Vitest (`lib/server/**`, `app/api/**`), Jest (everything else), PGlite for server tests.

**Spec:** `docs/superpowers/specs/2026-08-23-marketing-splash-page-design.md` — read it alongside
this plan. Where they disagree, the spec wins on *intent*; this plan wins on *symbol names and
commands*, which were verified against the repo on 2026-08-23.

**Branch:** the spec says `marketing-splash`. The work is already on **`splash-page`**, which is
the branch to use. Do not create a second branch.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Two test runners, disjoint ownership.** `npm run test:server` = Vitest, and its
  `vitest.config.ts` `include` is exactly `['lib/server/**/*.test.ts', 'app/api/**/*.test.ts']`
  (`.ts` only, never `.tsx`). `npm test` = Jest, which ignores `lib/server/` and `app/api/`.
  Running one is not a test pass.
- **`npm run build` is mandatory before calling the change done.** It is the only gate that catches
  Next segment-config and prerender failures, and this change adds a route group and a rewrite.
- **Never run `npx drizzle-kit pull`.** `lib/server/schema.ts`'s header forbids hand-editing the
  *shape* of introspected tables so the file cannot drift from the Alembic-owned database. Adding a
  brand-new ShelfSprite-owned table is a different operation — there is nothing to drift from.
  Hand-add it, touch no existing table.
- **`invite_requests` is deliberately not tenant-scoped.** Every other user-owned table carries a
  `user_id`. These rows come from people with no Supabase `sub` yet. This is the one deliberate
  exception to the CLAUDE.md tenancy rule and must not be "fixed".
- **Emails are normalized (trim + lowercase) in `lib/server/inviteRequests.ts` before every insert
  and lookup.** The unique index is on the raw column; there is no functional index.
- **The public endpoint must never be an enumeration oracle.** New request, duplicate request, and
  honeypot submission all return `200 {"ok": true}`. Only 422 (bad email) and 429 (rate limited)
  differ.
- **Do not use `rateLimitExceededResponse`.** It returns `{"error": ...}` for byte-compatibility
  with the retired Python SlowAPI handler. This route has no Python ancestor: throw
  `new ApiError(429, ...)` so it gets the normal `{"detail": ...}` shape.
- **Approve is deliberately not transactional**, mirroring `createInvite` / `revokeUser` in
  `lib/server/invites.ts`. The irreversible GoTrue call goes first; local bookkeeping follows. Do
  not harmonize it with `backfillFromSupabase`.
- **Nothing under `app/(marketing)/` may import `@/lib/api` or `@/utils/supabase/client`.** Both
  pull the Supabase browser client into a bundle whose entire audience is signed out. The waitlist
  form calls `fetch('/api/invite-requests', …)` directly.
- **`proxy.ts` is not modified.** Its matcher's `api` negative lookahead is load-bearing per
  CLAUDE.md.
- **Copy in Task 8 is final.** It was drafted against the `chase-writing-voice` skill and audited
  for AI tells. Transcribe it exactly; do not paraphrase, do not add em dashes.
- **Secrets are off-limits.** No task here reads, prints, or inspects local secret files; key
  *names* only, existence checks only.

### Verified facts this plan depends on (checked 2026-08-23 against source)

| Fact | Value |
|---|---|
| `withApi` signature | `withApi(routePath, handler, { requireAuth?, requireAdmin? })`, `lib/server/http.ts` |
| `ctx.params` | `Record<string, string>`; parse ids with `parseIdParam` from `lib/server/serialize.ts` |
| Local mode auth | no `SUPABASE_URL`/`SUPABASE_JWKS_URL` set ⇒ `{ userId: 'local', isAdmin: true }`. Admin route tests pass with no auth header. |
| `checkRateLimit` | `checkRateLimit(db, { key, limit, windowSeconds, nowMs? })` → `{ allowed, remaining, retryAfterSeconds }` |
| `createInvite` | `createInvite({ email, invitedBy, displayName?, anthropicApiKey? })` → `AdminUser`; throws `InviteError` / `SupabaseAdminError` |
| GoTrue test seam | `_setInviteUserForTests(fn \| null)`; `fn: (email: string) => Promise<{ id: string \| null; email: string }>` |
| Test env helper | `setupTestEnv()` from `lib/server/__tests__/helpers/testEnv.ts` (registers its own beforeEach/afterEach) |
| PGlite helper | `makeTestDb()` / `loadSeed(db, seed)` in `lib/server/__tests__/helpers/pglite.ts` — 17 hand-written `create table`s |
| Jest matches route groups | `npx jest --listTests` matched a probe at `app/(marketing)/__tests__/probe.test.tsx`. **Invoke it by basename** (`npx jest welcome.test.tsx`) — jest CLI args are regexes and bare `(` `)` will not match the literal directory name. |
| Middleware is Jest-testable | verified: `jest.resetModules()` + dynamic `import('../middleware')` after setting env (the module reads `process.env` at load time), `jest.mock('@supabase/ssr')`, `new NextRequest(new Request(url))`. Redirect ⇒ `status 307` + `location`; rewrite ⇒ `status 200` + `x-middleware-rewrite`. |
| Cookie-carrying rewrite | verified: `base.cookies.getAll().forEach((c) => rewrite.cookies.set(c))` copies every `set-cookie` onto the rewrite response |
| Zod 4 form | verified working: `z.string().trim().toLowerCase().email().max(254)` |
| `drizzle-kit generate` baseline | clean — `npm run db:generate` currently reports "No schema changes, nothing to migrate" |
| Placeholder images | `magick` (ImageMagick 7) is installed locally |

---

## Codex dispatch notes

Read `chase-workflow:codex-dispatch` before writing any dispatch prompt, and start from
`prompt-templates.md` rather than composing from memory.

**Gates the controller owns and must run every wave — never read their absence in a Codex report
as a pass:**

- `npm run build` — the sandbox has no network and the root layout pulls three Google Fonts via
  `next/font/google`, so the build dies fetching them.
- `npm run db:generate` and applying the migration — needs a live `DATABASE_URL` and hand
  inspection of the emitted SQL.
- Everything in Task 9 (spec §9.4): the browser walkthrough.

**Gates Codex can and should run**, per task (each was checked to match at least one real test):

```bash
npx vitest run lib/server/__tests__/invite-requests.test.ts
npx vitest run app/api/invite-requests/route.test.ts
npx vitest run lib/server/__tests__/admin-invite-request-routes.test.ts
npx jest middleware.test.ts
npx jest InviteHashRedirect.test.tsx
npx jest InviteRequestsTab.test.tsx
npx jest welcome.test.tsx
npm run type-check
npm run lint
npm run format:check
```

`npm run format:check` (prettier) is easy to forget and the stop hook enforces it. Keep it in every
dispatch that writes a file.

**Fresh dispatch, not resume, for any round that needs an edit** — a thread's sandbox writability
is fixed at creation.

---

## File structure

**Create**

| File | Responsibility |
|---|---|
| `lib/server/inviteRequests.ts` | Domain logic: normalize, submit, list, review, serialize, rate-limit key |
| `app/api/invite-requests/route.ts` | Public `POST` — honeypot, rate limit, insert-if-absent |
| `app/api/admin/invite-requests/route.ts` | Admin `GET` list, optional `?status=` |
| `app/api/admin/invite-requests/[id]/approve/route.ts` | Admin `POST` — `createInvite` then mark approved |
| `app/api/admin/invite-requests/[id]/decline/route.ts` | Admin `POST` — mark declined |
| `components/InviteHashRedirect.tsx` | Client island: forward a Supabase auth hash to `/auth/callback` |
| `components/admin/InviteRequestsTab.tsx` | Admin triage UI |
| `app/(marketing)/layout.tsx` | Minimal chrome-free layout for signed-out pages |
| `app/(marketing)/welcome/page.tsx` | The splash page (server component) |
| `app/(marketing)/welcome/WaitlistForm.tsx` | Client island: the waitlist form |
| `public/marketing/how-it-works.png` | Placeholder → real screenshot later |
| `public/marketing/taste-profile.png` | Placeholder → real screenshot later |
| `lib/server/__tests__/invite-requests.test.ts` | Vitest: schema round-trip + domain logic |
| `app/api/invite-requests/route.test.ts` | Vitest: the public endpoint |
| `lib/server/__tests__/admin-invite-request-routes.test.ts` | Vitest: the three admin routes |
| `utils/supabase/__tests__/middleware.test.ts` | Jest: rewrite / redirect / pass-through matrix |
| `components/__tests__/InviteHashRedirect.test.tsx` | Jest |
| `components/admin/__tests__/InviteRequestsTab.test.tsx` | Jest |
| `app/(marketing)/__tests__/welcome.test.tsx` | Jest |

**Modify**

| File | Change |
|---|---|
| `lib/server/schema.ts` | Add the `inviteRequests` table only |
| `lib/server/__tests__/helpers/pglite.ts` | Add `create table invite_requests`, extend `Seed`, `order`, `SEQ_TABLES`, `TS_COLS` |
| `lib/server/ratelimit.ts` | Add `RATE_LIMITS.inviteRequest` |
| `utils/supabase/middleware.ts` | Add `/welcome` to `PUBLIC_PREFIXES`; add the `/` rewrite branch |
| `lib/authRedirect.ts` | Update the header comment to describe both entry points |
| `app/login/page.tsx` | Replace the inline `useEffect` with `<InviteHashRedirect />` |
| `app/(main)/admin/page.tsx` | Add `'requests'` to the tab union and render the tab |
| `lib/api.ts` | Add the three admin invite-request client functions + types |
| `drizzle/` | One generated migration (controller runs the generator) |

**Naming deviation, stated up front:** the spec calls the domain test
`lib/server/__tests__/inviteRequests.test.ts` and the admin route tests
`app/api/admin/invite-requests/route.test.ts`. This plan uses
`lib/server/__tests__/invite-requests.test.ts` and
`lib/server/__tests__/admin-invite-request-routes.test.ts` instead, matching the kebab-case
convention every other file in `lib/server/__tests__/` follows (and the existing
`admin-feedback-routes.test.ts`, which colocates all three admin feedback routes in one file).
Vitest's `include` covers both locations, so this is style only.

---

## Task 1: Schema, migration, and the PGlite mirror

**Files:**
- Modify: `lib/server/schema.ts` (insert after the `invites` table, before `usageEvents`)
- Modify: `lib/server/__tests__/helpers/pglite.ts`
- Create: `lib/server/__tests__/invite-requests.test.ts`
- Generated: `drizzle/000N_*.sql` + `drizzle/meta/*` (controller step)

**Interfaces:**
- Consumes: nothing.
- Produces: `schema.inviteRequests` with columns `id: number`, `email: string`,
  `status: string`, `createdAt: string`, `reviewedAt: string | null`,
  `reviewedBy: string | null`; PGlite table `invite_requests`; `Seed.invite_requests`.

- [x] **Step 1: Write the failing test**

Create `lib/server/__tests__/invite-requests.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { schema } from '../db';

describe('invite_requests table', () => {
  it('round-trips a row through the drizzle schema', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(schema.inviteRequests).values({
        email: 'reader@example.com',
        status: 'pending',
      });
      const rows = await db.select().from(schema.inviteRequests);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 1,
        email: 'reader@example.com',
        status: 'pending',
        reviewedAt: null,
        reviewedBy: null,
      });
      expect(typeof rows[0].createdAt).toBe('string');
    } finally {
      await close();
    }
  });

  it('rejects a duplicate email at the database level', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db
        .insert(schema.inviteRequests)
        .values({ email: 'dupe@example.com', status: 'pending' });
      await expect(
        db.insert(schema.inviteRequests).values({ email: 'dupe@example.com', status: 'declined' })
      ).rejects.toThrow();
    } finally {
      await close();
    }
  });
});
```

- [x] **Step 2: Run it and confirm it fails**

Run: `npx vitest run lib/server/__tests__/invite-requests.test.ts`
Expected: FAIL — `schema.inviteRequests` is undefined.

- [x] **Step 3: Add the table to `lib/server/schema.ts`**

Insert immediately after the `invites` table block (which ends `);` before
`export const usageEvents`). Every identifier used here — `pgTable`, `serial`, `varchar`,
`timestamp`, `uniqueIndex`, `sql` — is already imported at the top of the file.

```ts
/**
 * Waitlist requests from the public marketing page.
 *
 * Hand-added, NOT introspected. The file header forbids hand-editing the shape of tables
 * that `drizzle-kit pull` produced from the Alembic-owned database, so the checked-in file
 * cannot drift from real column types. This table is new and owned by ShelfSprite alone, so
 * there is nothing to drift from. Do not run `drizzle-kit pull` to add it.
 *
 * DELIBERATELY NOT tenant-scoped. Every other user-owned table carries a user_id that forms
 * the tenancy boundary. These rows are submitted by people who have no Supabase `sub` yet, so
 * there is nothing to scope them to; they are readable only by admins. Do not "fix" this.
 *
 * The unique index is on the raw column, so lowercasing and trimming happen in
 * lib/server/inviteRequests.ts before every insert and lookup. `status` is a plain varchar
 * ('pending' | 'approved' | 'declined'), matching invites.status and feedback.status.
 */
export const inviteRequests = pgTable(
  'invite_requests',
  {
    id: serial().primaryKey().notNull(),
    email: varchar().notNull(),
    status: varchar().notNull(),
    createdAt: timestamp('created_at', { mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    reviewedAt: timestamp('reviewed_at', { mode: 'string' }),
    /** The reviewing admin's Supabase `sub`. */
    reviewedBy: varchar('reviewed_by'),
  },
  (table) => [
    uniqueIndex('ux_invite_requests_email').using(
      'btree',
      table.email.asc().nullsLast().op('text_ops')
    ),
  ]
);
```

- [x] **Step 4: Mirror the table in the PGlite helper**

In `lib/server/__tests__/helpers/pglite.ts`, append to the `pg.exec(...)` template literal, after
the `create table invites (...)` statement:

```sql
    create table invite_requests (
      id serial primary key,
      email text not null,
      status text not null,
      created_at timestamp not null default current_timestamp,
      reviewed_at timestamp,
      reviewed_by text
    );
    create unique index ux_invite_requests_email on invite_requests (email);
```

Then wire it into `loadSeed` so admin route tests can seed rows:

1. Add `invite_requests?: Record<string, unknown>[];` to the `Seed` interface.
2. Add `'reviewed_at',` to the `TS_COLS` set.
3. Add `'invite_requests',` to the `order` array (put it right after `'invites'`).
4. Add `'invite_requests',` to the `SEQ_TABLES` array.

- [x] **Step 5: Run the test and the full server suite**

```bash
npx vitest run lib/server/__tests__/invite-requests.test.ts
npm run test:server
```

Expected: the new file PASSES; the full server suite stays green (a missing PGlite table breaks
unrelated seeded tests, so this is the check that matters).

- [x] **Step 6: Generate and inspect the migration — CONTROLLER ONLY, do not delegate**

```bash
npm run db:generate
```

Then read `drizzle/000N_*.sql` by hand. Expect exactly one `CREATE TABLE "invite_requests"` and
one `CREATE UNIQUE INDEX "ux_invite_requests_email"`, and **no** statement touching any other
table. If anything else appears, stop: the snapshot has drifted and that is a separate problem.

- [x] **Step 7: Apply the migration and verify production shape — CONTROLLER ONLY**

Apply through the drizzle workflow in `docs/hosting.md` (`npm run db:migrate`). `drizzle-kit
generate` never reads a live database, so a clean generate proves nothing about production. After
applying, verify against the database itself:

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'invite_requests'
order by ordinal_position;
```

Record what you actually observe, not what this plan predicts. Expected: six columns, `email` /
`status` / `created_at` NOT NULL, `created_at` defaulting to `CURRENT_TIMESTAMP`, `reviewed_at`
and `reviewed_by` nullable.

- [x] **Step 8: Gates and commit**

```bash
npm run type-check && npm run lint && npm run format:check
git add lib/server/schema.ts lib/server/__tests__/helpers/pglite.ts \
        lib/server/__tests__/invite-requests.test.ts drizzle/
git commit -m "feat(db): add invite_requests table"
```

---

## Task 2: `lib/server/inviteRequests.ts`

**Files:**
- Create: `lib/server/inviteRequests.ts`
- Modify: `lib/server/__tests__/invite-requests.test.ts` (append two `describe` blocks)

**Interfaces:**
- Consumes: `schema.inviteRequests` (Task 1); `Db` and `schema` from `@/lib/server/db`;
  `tsToIso`, `utcnowTs` from `@/lib/server/serialize`.
- Produces:
  ```ts
  export interface AdminInviteRequest {
    id: number;
    email: string;
    status: string;
    created_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
  }
  export type InviteRequestStatus = 'pending' | 'approved' | 'declined';
  export const INVITE_REQUEST_STATUSES: readonly InviteRequestStatus[];
  export function isInviteRequestStatus(v: string): v is InviteRequestStatus;
  export function normalizeEmail(raw: string): string;
  export function inviteRequestRateKey(req: Request): string;
  export function serializeInviteRequest(row): AdminInviteRequest;
  export async function submitInviteRequest(db: Db, rawEmail: string): Promise<void>;
  export async function listInviteRequests(
    db: Db,
    status?: InviteRequestStatus | null
  ): Promise<AdminInviteRequest[]>;
  export async function getInviteRequest(db: Db, id: number): Promise<AdminInviteRequest | null>;
  export async function markReviewed(
    db: Db,
    id: number,
    status: 'approved' | 'declined',
    reviewedBy: string
  ): Promise<AdminInviteRequest | null>;
  ```

- [x] **Step 1: Write the failing tests**

Append to `lib/server/__tests__/invite-requests.test.ts` (add the new import next to the existing
ones at the top of the file):

```ts
import {
  normalizeEmail,
  inviteRequestRateKey,
  submitInviteRequest,
  listInviteRequests,
  getInviteRequest,
  markReviewed,
  isInviteRequestStatus,
} from '../inviteRequests';

describe('inviteRequests domain', () => {
  it('normalizes an email by trimming and lowercasing', () => {
    expect(normalizeEmail('  ChAsE@Example.COM ')).toBe('chase@example.com');
  });

  it('stores the normalized email', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, '  Reader@Example.COM ');
      const rows = await listInviteRequests(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('reader@example.com');
      expect(rows[0].status).toBe('pending');
      expect(rows[0].reviewed_at).toBeNull();
      expect(rows[0].reviewed_by).toBeNull();
    } finally {
      await close();
    }
  });

  it('treats a second submission of the same email as a no-op', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      await submitInviteRequest(db, 'reader@example.com');
      expect(await listInviteRequests(db)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('treats a differently-cased duplicate as a duplicate', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      await submitInviteRequest(db, '  READER@EXAMPLE.com');
      expect(await listInviteRequests(db)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('leaves an already-reviewed row untouched on resubmission', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);
      await markReviewed(db, row.id, 'declined', 'admin-sub');
      await submitInviteRequest(db, 'reader@example.com');
      const after = await listInviteRequests(db);
      expect(after).toHaveLength(1);
      expect(after[0].status).toBe('declined');
      expect(after[0].reviewed_by).toBe('admin-sub');
    } finally {
      await close();
    }
  });

  it('lists newest first and filters by status', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'one@example.com');
      await submitInviteRequest(db, 'two@example.com');
      const all = await listInviteRequests(db);
      expect(all.map((r) => r.email)).toEqual(['two@example.com', 'one@example.com']);

      await markReviewed(db, all[0].id, 'approved', 'admin-sub');
      expect((await listInviteRequests(db, 'pending')).map((r) => r.email)).toEqual([
        'one@example.com',
      ]);
      expect((await listInviteRequests(db, 'approved')).map((r) => r.email)).toEqual([
        'two@example.com',
      ]);
    } finally {
      await close();
    }
  });

  it('markReviewed stamps status, reviewer and timestamp; returns null for a missing id', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);
      const updated = await markReviewed(db, row.id, 'approved', 'admin-sub');
      expect(updated).toMatchObject({ status: 'approved', reviewed_by: 'admin-sub' });
      expect(typeof updated!.reviewed_at).toBe('string');
      expect(await markReviewed(db, 9999, 'declined', 'admin-sub')).toBeNull();
    } finally {
      await close();
    }
  });

  it('getInviteRequest returns the row or null', async () => {
    const { db, close } = await makeTestDb();
    try {
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);
      expect((await getInviteRequest(db, row.id))?.email).toBe('reader@example.com');
      expect(await getInviteRequest(db, 9999)).toBeNull();
    } finally {
      await close();
    }
  });

  it('isInviteRequestStatus guards the vocabulary', () => {
    expect(isInviteRequestStatus('pending')).toBe(true);
    expect(isInviteRequestStatus('spam')).toBe(false);
  });
});

describe('inviteRequestRateKey', () => {
  function req(headers: Record<string, string> = {}): Request {
    return new Request('http://test/api/invite-requests', { method: 'POST', headers });
  }

  it('uses the first x-forwarded-for entry, trimmed', () => {
    expect(inviteRequestRateKey(req({ 'x-forwarded-for': '203.0.113.5, 70.41.3.18' }))).toBe(
      'invite_request:203.0.113.5'
    );
    expect(inviteRequestRateKey(req({ 'x-forwarded-for': '  203.0.113.9  ' }))).toBe(
      'invite_request:203.0.113.9'
    );
  });

  it('falls back to one shared bucket when the header is absent or empty', () => {
    expect(inviteRequestRateKey(req())).toBe('invite_request:unknown');
    expect(inviteRequestRateKey(req({ 'x-forwarded-for': '   ' }))).toBe('invite_request:unknown');
  });

  it('gives different IPs different buckets', () => {
    expect(inviteRequestRateKey(req({ 'x-forwarded-for': '1.1.1.1' }))).not.toBe(
      inviteRequestRateKey(req({ 'x-forwarded-for': '2.2.2.2' }))
    );
  });
});
```

- [x] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/server/__tests__/invite-requests.test.ts`
Expected: FAIL — cannot resolve `../inviteRequests`.

- [x] **Step 3: Write the module**

Create `lib/server/inviteRequests.ts`:

```ts
/**
 * Invite-request (waitlist) domain logic. The public POST route and the three admin routes
 * stay thin and call in here, matching the rest of lib/server/.
 *
 * Emails are normalized here, on the way in AND on every lookup: the unique index is on the
 * raw `email` column, not a functional index, so normalization is this module's job alone.
 */
import { desc, eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { tsToIso, utcnowTs } from './serialize';

export const INVITE_REQUEST_STATUSES = ['pending', 'approved', 'declined'] as const;
export type InviteRequestStatus = (typeof INVITE_REQUEST_STATUSES)[number];

export function isInviteRequestStatus(value: string): value is InviteRequestStatus {
  return (INVITE_REQUEST_STATUSES as readonly string[]).includes(value);
}

/** The admin wire shape. Snake_case, matching every other admin payload. */
export interface AdminInviteRequest {
  id: number;
  email: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

type InviteRequestRow = typeof schema.inviteRequests.$inferSelect;

export function normalizeEmail(raw: string): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Bucket key for the public endpoint's rate limit. Every other entry in RATE_LIMITS is keyed
 * per authenticated user; this route has no user, so it keys on the client IP taken from the
 * first x-forwarded-for entry.
 *
 * A missing or blank header falls back to ONE shared constant bucket rather than skipping the
 * limit. That fails closed: header-less traffic contends for a single bucket instead of
 * bypassing the limiter entirely.
 */
export function inviteRequestRateKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0]?.trim() ?? '';
  return `invite_request:${ip || 'unknown'}`;
}

export function serializeInviteRequest(row: InviteRequestRow): AdminInviteRequest {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    // created_at is NOT NULL in the schema, so tsToIso never returns null here.
    created_at: tsToIso(row.createdAt)!,
    reviewed_at: tsToIso(row.reviewedAt),
    reviewed_by: row.reviewedBy,
  };
}

/**
 * Record a waitlist request. Idempotent on the normalized email: if a row already exists in
 * ANY status it is left exactly as it is, including an already-reviewed one. The caller must
 * respond identically either way — a distinguishable response would turn the public endpoint
 * into an oracle for "is this email already known to ShelfSprite".
 */
export async function submitInviteRequest(db: Db, rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  if (!email) return;

  const existing = await db
    .select({ id: schema.inviteRequests.id })
    .from(schema.inviteRequests)
    .where(eq(schema.inviteRequests.email, email))
    .limit(1);
  if (existing.length) return;

  await db.insert(schema.inviteRequests).values({ email, status: 'pending' });
}

/** Every request, newest first, optionally narrowed to one status. */
export async function listInviteRequests(
  db: Db,
  status?: InviteRequestStatus | null
): Promise<AdminInviteRequest[]> {
  const rows = await db
    .select()
    .from(schema.inviteRequests)
    .where(status ? eq(schema.inviteRequests.status, status) : undefined)
    .orderBy(desc(schema.inviteRequests.createdAt), desc(schema.inviteRequests.id));
  return rows.map(serializeInviteRequest);
}

export async function getInviteRequest(db: Db, id: number): Promise<AdminInviteRequest | null> {
  const [row] = await db
    .select()
    .from(schema.inviteRequests)
    .where(eq(schema.inviteRequests.id, id))
    .limit(1);
  return row ? serializeInviteRequest(row) : null;
}

/** Stamp a request reviewed. Returns null when the id does not exist. */
export async function markReviewed(
  db: Db,
  id: number,
  status: 'approved' | 'declined',
  reviewedBy: string
): Promise<AdminInviteRequest | null> {
  const [row] = await db
    .update(schema.inviteRequests)
    .set({ status, reviewedAt: utcnowTs(), reviewedBy })
    .where(eq(schema.inviteRequests.id, id))
    .returning();
  return row ? serializeInviteRequest(row) : null;
}
```

- [x] **Step 4: Run the tests**

```bash
npx vitest run lib/server/__tests__/invite-requests.test.ts
```

Expected: PASS, all cases.

Note on the "newest first" test: two rows inserted milliseconds apart can share a
`CURRENT_TIMESTAMP` value, which is exactly why the ordering is
`desc(createdAt), desc(id)` — the id breaks the tie. If that test is flaky, the ordering is
wrong, not the test.

- [x] **Step 5: Gates and commit**

```bash
npm run type-check && npm run lint && npm run format:check
git add lib/server/inviteRequests.ts lib/server/__tests__/invite-requests.test.ts
git commit -m "feat(server): add invite-request domain module"
```

---

## Task 3: `RATE_LIMITS.inviteRequest` and the public `POST /api/invite-requests`

**Files:**
- Modify: `lib/server/ratelimit.ts`
- Create: `app/api/invite-requests/route.ts`
- Create: `app/api/invite-requests/route.test.ts`

**Interfaces:**
- Consumes: `submitInviteRequest`, `inviteRequestRateKey`, `listInviteRequests` (Task 2);
  `checkRateLimit`, `RATE_LIMITS` from `@/lib/server/ratelimit`; `withApi`, `ApiError` from
  `@/lib/server/http`.
- Produces: `POST /api/invite-requests` returning `200 {"ok": true}` on every accepted outcome;
  `RATE_LIMITS.inviteRequest = { limit: 5, windowSeconds: 3600 }`.

- [x] **Step 1: Write the failing test**

Create `app/api/invite-requests/route.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { setupTestEnv } from '@/lib/server/__tests__/helpers/testEnv';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { listInviteRequests } from '@/lib/server/inviteRequests';
import { RATE_LIMITS } from '@/lib/server/ratelimit';
import { POST } from './route';

setupTestEnv();
afterEach(() => vi.restoreAllMocks());

function silenceLogs() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://test/api/invite-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  silenceLogs();
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

describe('POST /api/invite-requests', () => {
  it('exposes a 5-per-hour limit', () => {
    expect(RATE_LIMITS.inviteRequest).toEqual({ limit: 5, windowSeconds: 3600 });
  });

  it('accepts a new email, returns {ok:true}, writes exactly one row', async () => {
    await withDb(async (db) => {
      const res = await POST(post({ email: '  Reader@Example.COM ' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const rows = await listInviteRequests(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('reader@example.com');
      expect(rows[0].status).toBe('pending');
    });
  });

  it('returns the identical body for a duplicate and writes no second row', async () => {
    await withDb(async (db) => {
      const first = await POST(post({ email: 'reader@example.com' }));
      const second = await POST(post({ email: 'READER@example.com' }));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ ok: true });
      expect(await listInviteRequests(db)).toHaveLength(1);
    });
  });

  it('silently swallows a filled honeypot: same body, nothing written', async () => {
    await withDb(async (db) => {
      const res = await POST(post({ email: 'bot@example.com', website: 'http://spam.example' }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await listInviteRequests(db)).toHaveLength(0);
    });
  });

  it('does not consume the rate limit when the honeypot is filled', async () => {
    await withDb(async (db) => {
      const h = { 'x-forwarded-for': '203.0.113.7' };
      for (let i = 0; i < 20; i++) {
        await POST(post({ email: `bot${i}@example.com`, website: 'x' }, h));
      }
      const res = await POST(post({ email: 'human@example.com' }, h));
      expect(res.status).toBe(200);
      expect(await listInviteRequests(db)).toHaveLength(1);
    });
  });

  it('rejects a malformed email with 422 and a {detail} body', async () => {
    await withDb(async () => {
      const res = await POST(post({ email: 'not-an-email' }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(typeof body.detail).toBe('string');
    });
  });

  it('rejects a non-JSON body with 422', async () => {
    await withDb(async () => {
      const res = await POST(
        new Request('http://test/api/invite-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        })
      );
      expect(res.status).toBe(422);
    });
  });

  it('allows the 5th request and 429s the 6th, with the {detail} shape not {error}', async () => {
    await withDb(async () => {
      const h = { 'x-forwarded-for': '198.51.100.4' };
      for (let i = 0; i < 5; i++) {
        const ok = await POST(post({ email: `person${i}@example.com` }, h));
        expect(ok.status).toBe(200);
      }
      const blocked = await POST(post({ email: 'person5@example.com' }, h));
      expect(blocked.status).toBe(429);
      const body = await blocked.json();
      expect(typeof body.detail).toBe('string');
      expect(body).not.toHaveProperty('error');
    });
  });

  it('does not share a bucket between two x-forwarded-for values', async () => {
    await withDb(async () => {
      for (let i = 0; i < 5; i++) {
        await POST(post({ email: `a${i}@example.com` }, { 'x-forwarded-for': '198.51.100.10' }));
      }
      const blocked = await POST(
        post({ email: 'a5@example.com' }, { 'x-forwarded-for': '198.51.100.10' })
      );
      expect(blocked.status).toBe(429);

      const other = await POST(
        post({ email: 'b0@example.com' }, { 'x-forwarded-for': '198.51.100.11' })
      );
      expect(other.status).toBe(200);
    });
  });

  it('still consumes a limit when x-forwarded-for is absent', async () => {
    await withDb(async () => {
      for (let i = 0; i < 5; i++) {
        const ok = await POST(post({ email: `c${i}@example.com` }));
        expect(ok.status).toBe(200);
      }
      const blocked = await POST(post({ email: 'c5@example.com' }));
      expect(blocked.status).toBe(429);
    });
  });
});
```

- [x] **Step 2: Run and confirm failure**

Run: `npx vitest run app/api/invite-requests/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [x] **Step 3: Add the rate-limit entry**

In `lib/server/ratelimit.ts`, extend the exported `RATE_LIMITS` object. Keep the existing parity
comment above it intact and add the new entry with its own note:

```ts
export const RATE_LIMITS = {
  catalogSearch: { limit: 30, windowSeconds: 60 },
  enrichStart: { limit: 5, windowSeconds: 60 },
  directiveDraft: { limit: 30, windowSeconds: 60 },
  booksSimilar: { limit: 15, windowSeconds: 60 },
  discover: { limit: 30, windowSeconds: 60 },
  /**
   * No Python ancestor: the public waitlist endpoint. Unlike every entry above it, its bucket
   * key is IP-derived rather than per-user, because the route has no authenticated caller
   * (see inviteRequestRateKey in inviteRequests.ts). It also does NOT use
   * rateLimitExceededResponse — that helper's {"error": ...} shape exists only for SlowAPI
   * byte-parity, and this route should carry the normal {"detail": ...} shape.
   */
  inviteRequest: { limit: 5, windowSeconds: 3600 },
} as const;
```

- [x] **Step 4: Write the route**

Create `app/api/invite-requests/route.ts`:

```ts
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';
import { inviteRequestRateKey, submitInviteRequest } from '@/lib/server/inviteRequests';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  /** Honeypot. Hidden from real users, so any value at all means a bot filled it. */
  website: z.string().optional(),
});

/**
 * Public waitlist submission. `requireAuth: false` because the entire audience is signed out.
 *
 * Every accepted outcome — new email, duplicate email, honeypot — returns the SAME
 * 200 {"ok": true}. A distinguishable response would make this endpoint an oracle for "is this
 * email already known to ShelfSprite", which on an invite-only product leaks the user list. Only
 * 422 (Zod rejected the email) and 429 (rate limited) differ.
 */
export const POST = withApi(
  '/api/invite-requests',
  async (req, ctx) => {
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        422,
        `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
      );
    }

    // Honeypot first, before the limiter: a bot must not be able to burn a real visitor's
    // shared bucket, and there is nothing here worth logging or storing.
    if (parsed.data.website && parsed.data.website.length > 0) {
      return Response.json({ ok: true });
    }

    const db = getDb();
    const { limit, windowSeconds } = RATE_LIMITS.inviteRequest;
    const rate = await checkRateLimit(db, {
      key: inviteRequestRateKey(req),
      limit,
      windowSeconds,
    });
    if (!rate.allowed) {
      // Deliberately NOT rateLimitExceededResponse — see the note in ratelimit.ts.
      throw new ApiError(429, 'too many invite requests, try again later');
    }

    await submitInviteRequest(db, parsed.data.email);
    ctx.timer.mark('db');
    return Response.json({ ok: true });
  },
  { requireAuth: false }
);
```

- [x] **Step 5: Run the tests**

```bash
npx vitest run app/api/invite-requests/route.test.ts
npx vitest run lib/server/__tests__/ratelimit-routes.test.ts
```

Expected: both PASS. (The second confirms the `RATE_LIMITS` edit did not disturb the five
existing byte-parity routes.)

- [x] **Step 6: Mutation check — three minutes, do it**

Temporarily change the honeypot guard to `if (false)` and re-run the suite. The "silently
swallows a filled honeypot" and "does not consume the rate limit" tests must both go red. Then
change the 429 branch to return `rateLimitExceededResponse(limit, windowSeconds)` directly and
confirm the `{detail}`-shape test goes red. Revert both. If either stays green, the test is not
testing what it claims.

- [x] **Step 7: Gates and commit**

```bash
npm run type-check && npm run lint && npm run format:check
git add lib/server/ratelimit.ts app/api/invite-requests/
git commit -m "feat(api): public invite-request endpoint with honeypot and IP rate limit"
```

---

## Task 4: The three admin routes

**Files:**
- Create: `app/api/admin/invite-requests/route.ts`
- Create: `app/api/admin/invite-requests/[id]/approve/route.ts`
- Create: `app/api/admin/invite-requests/[id]/decline/route.ts`
- Create: `lib/server/__tests__/admin-invite-request-routes.test.ts`

**Interfaces:**
- Consumes: `listInviteRequests`, `getInviteRequest`, `markReviewed`, `isInviteRequestStatus`,
  `AdminInviteRequest` (Task 2); `createInvite`, `InviteError`, `_setInviteUserForTests` from
  `@/lib/server/invites`; `SupabaseAdminError` from `@/lib/server/supabaseAdmin`; `parseIdParam`
  from `@/lib/server/serialize`.
- Produces:
  - `GET /api/admin/invite-requests[?status=pending|approved|declined]` → `AdminInviteRequest[]`
  - `POST /api/admin/invite-requests/{id}/approve` → `AdminInviteRequest`
  - `POST /api/admin/invite-requests/{id}/decline` → `AdminInviteRequest`

**Route context note.** Next passes `{ params }` as the second argument; `withApi` awaits it and
exposes `ctx.params.id`. In tests, call the exported handler as
`POST(request, { params: { id: '1' } })` — `withApi` accepts a plain object or a promise.

- [x] **Step 1: Write the failing tests**

Create `lib/server/__tests__/admin-invite-request-routes.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { _setDbForTests, type Db } from '../db';
import { invites } from '../schema';
import { SupabaseAdminError } from '../supabaseAdmin';
import { listInviteRequests, submitInviteRequest } from '../inviteRequests';
import { _setInviteUserForTests } from '../invites';
import { GET as listRoute } from '../../../app/api/admin/invite-requests/route';
import { POST as approveRoute } from '../../../app/api/admin/invite-requests/[id]/approve/route';
import { POST as declineRoute } from '../../../app/api/admin/invite-requests/[id]/decline/route';

setupTestEnv();
afterEach(() => {
  _setInviteUserForTests(null);
  vi.restoreAllMocks();
});

function silenceLogs() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

async function withDb(fn: (db: Db) => Promise<void>): Promise<void> {
  silenceLogs();
  const { db, close } = await makeTestDb();
  try {
    _setDbForTests(db);
    await fn(db);
  } finally {
    _setDbForTests(null);
    await close();
  }
}

const listReq = (qs = '') => new Request(`http://test/api/admin/invite-requests${qs}`);
const actionReq = () =>
  new Request('http://test/api/admin/invite-requests/1/approve', { method: 'POST' });

describe('GET /api/admin/invite-requests', () => {
  it('lists every request newest first', async () => {
    await withDb(async (db) => {
      await submitInviteRequest(db, 'one@example.com');
      await submitInviteRequest(db, 'two@example.com');
      const res = await listRoute(listReq());
      expect(res.status).toBe(200);
      const body = (await res.json()) as { email: string }[];
      expect(body.map((r) => r.email)).toEqual(['two@example.com', 'one@example.com']);
    });
  });

  it('filters by status', async () => {
    await withDb(async (db) => {
      await submitInviteRequest(db, 'one@example.com');
      await submitInviteRequest(db, 'two@example.com');
      const [newest] = await listInviteRequests(db);
      await declineRoute(actionReq(), { params: { id: String(newest.id) } });

      const pending = (await (await listRoute(listReq('?status=pending'))).json()) as {
        email: string;
      }[];
      expect(pending.map((r) => r.email)).toEqual(['one@example.com']);

      const declined = (await (await listRoute(listReq('?status=declined'))).json()) as {
        email: string;
      }[];
      expect(declined.map((r) => r.email)).toEqual(['two@example.com']);
    });
  });

  it('rejects an unknown status with 422', async () => {
    await withDb(async () => {
      const res = await listRoute(listReq('?status=spam'));
      expect(res.status).toBe(422);
      expect(typeof (await res.json()).detail).toBe('string');
    });
  });
});

describe('POST /api/admin/invite-requests/[id]/approve', () => {
  it('calls createInvite once with the row email and caller userId, then marks approved', async () => {
    await withDb(async (db) => {
      const calls: string[] = [];
      _setInviteUserForTests(async (email: string) => {
        calls.push(email);
        return { id: 'sb-user-1', email };
      });
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);

      const res = await approveRoute(actionReq(), { params: { id: String(row.id) } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: 'approved', reviewed_by: 'local' });
      expect(typeof body.reviewed_at).toBe('string');
      expect(calls).toEqual(['reader@example.com']);

      const roster = await db.select().from(invites);
      expect(roster.map((i) => i.email)).toEqual(['reader@example.com']);
      expect(roster[0].invitedBy).toBe('local');
    });
  });

  it('leaves the row pending and errors when createInvite throws', async () => {
    await withDb(async (db) => {
      _setInviteUserForTests(async () => {
        throw new SupabaseAdminError('GoTrue is down');
      });
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);

      const res = await approveRoute(actionReq(), { params: { id: String(row.id) } });
      expect(res.status).toBe(502);
      expect(typeof (await res.json()).detail).toBe('string');

      const [after] = await listInviteRequests(db);
      expect(after.status).toBe('pending');
      expect(after.reviewed_by).toBeNull();
    });
  });

  it('404s an unknown id without calling createInvite', async () => {
    await withDb(async () => {
      let called = false;
      _setInviteUserForTests(async (email: string) => {
        called = true;
        return { id: 'sb', email };
      });
      const res = await approveRoute(actionReq(), { params: { id: '9999' } });
      expect(res.status).toBe(404);
      expect(called).toBe(false);
    });
  });
});

describe('POST /api/admin/invite-requests/[id]/decline', () => {
  it('marks declined without calling createInvite', async () => {
    await withDb(async (db) => {
      let called = false;
      _setInviteUserForTests(async (email: string) => {
        called = true;
        return { id: 'sb', email };
      });
      await submitInviteRequest(db, 'reader@example.com');
      const [row] = await listInviteRequests(db);

      const res = await declineRoute(actionReq(), { params: { id: String(row.id) } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'declined', reviewed_by: 'local' });
      expect(called).toBe(false);
    });
  });

  it('404s an unknown id', async () => {
    await withDb(async () => {
      const res = await declineRoute(actionReq(), { params: { id: '9999' } });
      expect(res.status).toBe(404);
    });
  });
});

/**
 * Auth gating. setupTestEnv() deletes every SUPABASE_* variable, which puts verifyRequestUser in
 * local mode where the caller is an implicit admin — that is why every test above passes with no
 * Authorization header. Setting SUPABASE_JWKS_URL flips auth on; with no bearer token
 * verifyRequestUser throws AuthError before any network call, so no JWKS fetch happens.
 *
 * The authenticated-non-admin 403 case is NOT covered here on purpose. withApi calls
 * verifyRequestUser with no injectable JWKS, so reaching that branch from a route test would mean
 * mocking `jose` wholesale. lib/server/__tests__/http.test.ts already owns withApi's admin gate
 * directly, and these three routes pass { requireAdmin: true } verbatim — three lines a reviewer
 * can read. Mocking the crypto library to re-test a wrapper's own behavior buys nothing.
 */
describe('admin gating', () => {
  it('401s an unauthenticated caller once auth is enabled', async () => {
    await withDb(async () => {
      process.env.SUPABASE_JWKS_URL = 'https://example.test/jwks.json';
      const res = await listRoute(listReq());
      expect(res.status).toBe(401);
      expect(typeof (await res.json()).detail).toBe('string');
    });
  });
});
```

- [x] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/server/__tests__/admin-invite-request-routes.test.ts`
Expected: FAIL — the three route modules do not exist.

- [x] **Step 3: Write the list route**

Create `app/api/admin/invite-requests/route.ts`:

```ts
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { isInviteRequestStatus, listInviteRequests } from '@/lib/server/inviteRequests';

/** Every waitlist request, newest first. Optional ?status=pending|approved|declined. */
export const GET = withApi(
  '/api/admin/invite-requests',
  async (req, ctx) => {
    const raw = new URL(req.url).searchParams.get('status');
    if (raw !== null && !isInviteRequestStatus(raw)) {
      throw new ApiError(422, 'validation error: unknown invite request status');
    }
    const rows = await listInviteRequests(getDb(), raw);
    ctx.timer.mark('db');
    return Response.json(rows);
  },
  { requireAdmin: true }
);
```

- [x] **Step 4: Write the approve route**

Create `app/api/admin/invite-requests/[id]/approve/route.ts`:

```ts
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { getInviteRequest, markReviewed } from '@/lib/server/inviteRequests';
import { createInvite, InviteError } from '@/lib/server/invites';
import { SupabaseAdminError } from '@/lib/server/supabaseAdmin';

/**
 * Approve a waitlist request: send the real invite, then record the review.
 *
 * DELIBERATELY NOT TRANSACTIONAL — do not "fix" this. createInvite performs a GoTrue write that
 * cannot be rolled back, which is the same reason createInvite itself is not wrapped in a
 * transaction while backfillFromSupabase is (see lib/server/invites.ts). The irreversible remote
 * call goes first and the local bookkeeping follows it.
 *
 * If createInvite throws, the row stays 'pending', the admin sees the error, and the action is
 * safely retryable. If it succeeds and the status update then fails, the admin sees the invite in
 * the roster next to a still-pending request — visible, harmless, and cleared by approving again,
 * since createInvite already upserts on an existing email.
 */
export const POST = withApi(
  '/api/admin/invite-requests/[id]/approve',
  async (_req, ctx) => {
    const id = parseIdParam(ctx.params.id);
    const db = getDb();

    const row = await getInviteRequest(db, id);
    if (!row) throw new ApiError(404, 'invite request not found');

    try {
      await createInvite({ email: row.email, invitedBy: ctx.user.userId });
    } catch (err) {
      if (err instanceof InviteError) throw new ApiError(422, err.message);
      if (err instanceof SupabaseAdminError) throw new ApiError(502, err.message);
      throw err;
    }
    ctx.timer.mark('invite');

    const updated = await markReviewed(db, id, 'approved', ctx.user.userId);
    if (!updated) throw new ApiError(404, 'invite request not found');
    return Response.json(updated);
  },
  { requireAdmin: true }
);
```

- [x] **Step 5: Write the decline route**

Create `app/api/admin/invite-requests/[id]/decline/route.ts`:

```ts
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { markReviewed } from '@/lib/server/inviteRequests';

/** Decline a waitlist request. Local bookkeeping only — no GoTrue call. */
export const POST = withApi(
  '/api/admin/invite-requests/[id]/decline',
  async (_req, ctx) => {
    const id = parseIdParam(ctx.params.id);
    const updated = await markReviewed(getDb(), id, 'declined', ctx.user.userId);
    if (!updated) throw new ApiError(404, 'invite request not found');
    ctx.timer.mark('db');
    return Response.json(updated);
  },
  { requireAdmin: true }
);
```

- [x] **Step 6: Run the tests**

```bash
npx vitest run lib/server/__tests__/admin-invite-request-routes.test.ts
npm run test:server
```

Expected: both PASS.

- [x] **Step 7: Mutation check**

Swap the approve route's order so `markReviewed` runs before `createInvite`. The "leaves the row
pending" test must go red. Revert. If it stays green, that test is not proving the ordering the
comment claims.

- [x] **Step 8: Gates and commit**

```bash
npm run type-check && npm run lint && npm run format:check
git add app/api/admin/invite-requests/ lib/server/__tests__/admin-invite-request-routes.test.ts
git commit -m "feat(api): admin invite-request list, approve and decline routes"
```

---

## Task 5: Admin client functions, `InviteRequestsTab`, and page wiring

**Files:**
- Modify: `lib/api.ts` (append to the admin console section, after `createFeedbackGithubIssue`)
- Create: `components/admin/InviteRequestsTab.tsx`
- Modify: `app/(main)/admin/page.tsx`
- Create: `components/admin/__tests__/InviteRequestsTab.test.tsx`

**Interfaces:**
- Consumes: the three admin routes from Task 4.
- Produces:
  ```ts
  export interface AdminInviteRequest {
    id: number;
    email: string;
    status: string;
    created_at: string;
    reviewed_at: string | null;
    reviewed_by: string | null;
  }
  export function listAdminInviteRequests(status?: string): Promise<AdminInviteRequest[]>;
  export function approveInviteRequest(id: number): Promise<AdminInviteRequest>;
  export function declineInviteRequest(id: number): Promise<AdminInviteRequest>;
  export function InviteRequestsTab(): JSX.Element; // named export, like FeedbackTab
  ```

- [x] **Step 1: Write the failing test**

Create `components/admin/__tests__/InviteRequestsTab.test.tsx`, following the mocking pattern
already used in `components/admin/__tests__/FeedbackTab.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InviteRequestsTab } from '@/components/admin/InviteRequestsTab';
import { ToastProvider } from '@/components/ui';

const listAdminInviteRequests = jest.fn();
const approveInviteRequest = jest.fn();
const declineInviteRequest = jest.fn();

jest.mock('@/lib/api', () => ({
  listAdminInviteRequests: (...a: unknown[]) => listAdminInviteRequests(...a),
  approveInviteRequest: (...a: unknown[]) => approveInviteRequest(...a),
  declineInviteRequest: (...a: unknown[]) => declineInviteRequest(...a),
}));

// Call the fetcher once per key without involving SWR's shared cache.
jest.mock('swr', () => {
  const React = jest.requireActual('react');
  function useMockSWR(key: unknown, fetcher: () => Promise<unknown>) {
    const [data, setData] = React.useState(undefined);
    React.useEffect(() => {
      let alive = true;
      fetcher().then((d: unknown) => {
        if (alive) setData(d);
      });
      return () => {
        alive = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(key)]);
    return { data, isLoading: data === undefined, mutate: jest.fn() };
  }
  return { __esModule: true, default: useMockSWR };
});

const PENDING = {
  id: 1,
  email: 'reader@example.com',
  status: 'pending',
  created_at: '2026-08-20T00:00:00',
  reviewed_at: null,
  reviewed_by: null,
};

function renderTab(rows = [PENDING]) {
  listAdminInviteRequests.mockResolvedValue(rows);
  return render(
    <ToastProvider>
      <InviteRequestsTab />
    </ToastProvider>
  );
}

beforeEach(() => jest.clearAllMocks());

describe('InviteRequestsTab', () => {
  it('renders email, status and submitted date', async () => {
    renderTab();
    expect(await screen.findByText('reader@example.com')).toBeInTheDocument();
    expect(screen.getByText('pending')).toBeInTheDocument();
  });

  it('shows Approve and Decline on a pending row', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
  });

  it('hides the actions on a reviewed row', async () => {
    renderTab([{ ...PENDING, status: 'approved', reviewed_at: '2026-08-21T00:00:00' }]);
    expect(await screen.findByText('approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('approving calls the API with the row id and swaps the row to approved', async () => {
    renderTab();
    approveInviteRequest.mockResolvedValue({
      ...PENDING,
      status: 'approved',
      reviewed_at: '2026-08-21T00:00:00',
    });
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(approveInviteRequest).toHaveBeenCalledWith(1));
    expect(await screen.findByText('approved')).toBeInTheDocument();
  });

  it('declining calls the API and never calls approve', async () => {
    renderTab();
    declineInviteRequest.mockResolvedValue({
      ...PENDING,
      status: 'declined',
      reviewed_at: '2026-08-21T00:00:00',
    });
    fireEvent.click(await screen.findByRole('button', { name: /decline/i }));
    await waitFor(() => expect(declineInviteRequest).toHaveBeenCalledWith(1));
    expect(approveInviteRequest).not.toHaveBeenCalled();
  });

  it('leaves the row pending when approving fails', async () => {
    renderTab();
    approveInviteRequest.mockRejectedValue(new Error('GoTrue is down'));
    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    await waitFor(() => expect(approveInviteRequest).toHaveBeenCalled());
    expect(await screen.findByText('pending')).toBeInTheDocument();
  });

  it('renders an empty state', async () => {
    renderTab([]);
    expect(await screen.findByText(/no invite requests/i)).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run and confirm failure**

Run: `npx jest InviteRequestsTab.test.tsx`
Expected: FAIL — cannot resolve `@/components/admin/InviteRequestsTab`.

- [x] **Step 3: Add the client functions to `lib/api.ts`**

Append after `createFeedbackGithubIssue`, before the `// ── Spend guardrails ──` divider:

```ts
export interface AdminInviteRequest {
  id: number;
  email: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

/** Waitlist requests, newest first (admin-only). GET /admin/invite-requests */
export function listAdminInviteRequests(status?: string): Promise<AdminInviteRequest[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return get<AdminInviteRequest[]>(`/admin/invite-requests${qs}`);
}

/**
 * Send the real invite for one request and mark it approved (admin-only).
 * POST /admin/invite-requests/{id}/approve
 */
export const approveInviteRequest = (id: number): Promise<AdminInviteRequest> =>
  post<AdminInviteRequest>(`/admin/invite-requests/${id}/approve`, {});

/** Mark one request declined (admin-only). POST /admin/invite-requests/{id}/decline */
export const declineInviteRequest = (id: number): Promise<AdminInviteRequest> =>
  post<AdminInviteRequest>(`/admin/invite-requests/${id}/decline`, {});
```

- [x] **Step 4: Write the tab**

Create `components/admin/InviteRequestsTab.tsx`:

```tsx
'use client';

import { useState } from 'react';
import useSWR from 'swr';
import {
  listAdminInviteRequests,
  approveInviteRequest,
  declineInviteRequest,
  type AdminInviteRequest,
} from '@/lib/api';
import { Badge, Button, Card, Field, Spinner, useToast } from '@/components/ui';

const STATUS_VARIANT: Record<string, 'default' | 'success' | 'danger' | 'warning'> = {
  pending: 'warning',
  approved: 'success',
  declined: 'danger',
};

const selectClasses =
  'rounded-lg border border-border bg-base px-2 py-1 text-xs text-text focus:border-accent focus:outline-none';

/**
 * Waitlist triage. Volume is expected to be small, so the list is unpaginated — Pagination.tsx is
 * only worth wiring in if the route ever paginates server-side. No count badge on the tab button
 * either: no other admin tab carries one, and a lone counter is an inconsistency this change does
 * not need.
 */
export function InviteRequestsTab() {
  const [status, setStatus] = useState('pending');
  const { data, isLoading, mutate } = useSWR(['admin-invite-requests', status] as const, () =>
    listAdminInviteRequests(status || undefined)
  );

  function applyUpdated(updated: AdminInviteRequest) {
    // If the row no longer matches the active filter, drop it and revalidate; otherwise splice it
    // back in place without a refetch.
    const stillMatches = !status || updated.status === status;
    void mutate(
      (current) =>
        current
          ? stillMatches
            ? current.map((r) => (r.id === updated.id ? updated : r))
            : current.filter((r) => r.id !== updated.id)
          : current,
      { revalidate: !stillMatches }
    );
  }

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
        <div>
          <h2 className="font-display text-lg font-semibold text-text">Invite requests</h2>
          {data ? (
            <p className="text-xs text-faint">
              {data.length} request{data.length !== 1 ? 's' : ''}
            </p>
          ) : null}
        </div>
        <Field label="Filter by status">
          {(p) => (
            <select
              {...p}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className={selectClasses}
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="declined">Declined</option>
              <option value="">All</option>
            </select>
          )}
        </Field>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner label="Loading invite requests" />
        </div>
      ) : !data || data.length === 0 ? (
        <p className="p-5 text-sm text-faint">No invite requests yet.</p>
      ) : (
        <div className="mt-4 divide-y divide-border">
          {data.map((row) => (
            <RequestRow key={row.id} row={row} onUpdated={applyUpdated} />
          ))}
        </div>
      )}
    </Card>
  );
}

function RequestRow({
  row,
  onUpdated,
}: {
  row: AdminInviteRequest;
  onUpdated: (updated: AdminInviteRequest) => void;
}) {
  const [busy, setBusy] = useState<'approve' | 'decline' | null>(null);
  const toast = useToast();

  async function run(action: 'approve' | 'decline') {
    setBusy(action);
    try {
      const updated =
        action === 'approve'
          ? await approveInviteRequest(row.id)
          : await declineInviteRequest(row.id);
      onUpdated(updated);
      toast.success(action === 'approve' ? `Invite sent to ${row.email}.` : 'Request declined.');
    } catch (err) {
      // The row keeps showing its persisted status when the request fails.
      toast.error(err instanceof Error ? err.message : 'Could not update the request.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 px-5 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text">{row.email}</p>
        <p className="font-mono text-xs text-faint">
          {new Date(row.created_at).toLocaleDateString()}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={STATUS_VARIANT[row.status] ?? 'default'}>{row.status}</Badge>
        {row.status === 'pending' ? (
          <>
            <Button
              size="sm"
              loading={busy === 'approve'}
              disabled={busy !== null}
              onClick={() => void run('approve')}
            >
              Approve
            </Button>
            <Button
              variant="ghost"
              size="sm"
              loading={busy === 'decline'}
              disabled={busy !== null}
              onClick={() => void run('decline')}
            >
              Decline
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
```

- [x] **Step 5: Wire the tab into the admin page**

Three edits in `app/(main)/admin/page.tsx`:

1. Add the import next to the other tab imports:
   ```tsx
   import { InviteRequestsTab } from '@/components/admin/InviteRequestsTab';
   ```
2. Widen the tab state union:
   ```tsx
   const [tab, setTab] = useState<'users' | 'requests' | 'usage' | 'feedback' | 'system'>('users');
   ```
3. Add `'requests'` to the rendered tab list and to the render branch:
   ```tsx
   {(['users', 'requests', 'usage', 'feedback', 'system'] as const).map((t) => (
   ```
   ```tsx
   ) : tab === 'requests' ? (
     <InviteRequestsTab />
   ) : tab === 'usage' ? (
   ```
   The `capitalize` class already on the tab button renders `requests` as "Requests".

- [x] **Step 6: Run the tests**

```bash
npx jest InviteRequestsTab.test.tsx
npm test
```

Expected: both PASS.

- [x] **Step 7: Gates and commit**

```bash
npm run type-check && npm run lint && npm run format:check
git add lib/api.ts components/admin/InviteRequestsTab.tsx \
        components/admin/__tests__/InviteRequestsTab.test.tsx "app/(main)/admin/page.tsx"
git commit -m "feat(admin): invite requests triage tab"
```

---

## Task 6: Extract `InviteHashRedirect`

This is the mitigation for the highest-risk part of the change. Do it **before** the middleware
rewrite (Task 7), so the rescue exists the moment the rewrite starts skipping `/login`.

**Files:**
- Create: `components/InviteHashRedirect.tsx`
- Create: `components/__tests__/InviteHashRedirect.test.tsx`
- Modify: `app/login/page.tsx`
- Modify: `lib/authRedirect.ts` (header comment only)

**Interfaces:**
- Consumes: `inviteCallbackRedirect(hash: string): string | null` from `@/lib/authRedirect`
  (zero imports of its own — that is why it is safe on a page that must not pull in Supabase).
- Produces: `export default function InviteHashRedirect(): null` — a render-nothing client island.

- [x] **Step 1: Write the failing test**

Create `components/__tests__/InviteHashRedirect.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { render } from '@testing-library/react';
import InviteHashRedirect from '@/components/InviteHashRedirect';

const replace = jest.fn();

function setHash(hash: string) {
  // window.location is not writable in jsdom; replace it with a stub carrying our hash.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { hash, replace },
  });
}

beforeEach(() => replace.mockClear());

describe('InviteHashRedirect', () => {
  it('forwards an invite hash to /auth/callback with the fragment preserved', () => {
    setHash('#access_token=abc123&type=invite&refresh_token=def');
    render(<InviteHashRedirect />);
    expect(replace).toHaveBeenCalledWith(
      '/auth/callback#access_token=abc123&type=invite&refresh_token=def'
    );
  });

  it('forwards a recovery hash', () => {
    setHash('#type=recovery&access_token=xyz');
    render(<InviteHashRedirect />);
    expect(replace).toHaveBeenCalledWith('/auth/callback#type=recovery&access_token=xyz');
  });

  it('forwards an auth error hash so the callback page can render it', () => {
    setHash('#error=access_denied&error_description=Email+link+is+invalid');
    render(<InviteHashRedirect />);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty hash', () => {
    setHash('');
    render(<InviteHashRedirect />);
    expect(replace).not.toHaveBeenCalled();
  });

  it('does nothing for an unrelated hash', () => {
    setHash('#how-it-works');
    render(<InviteHashRedirect />);
    expect(replace).not.toHaveBeenCalled();
  });

  it('renders nothing', () => {
    setHash('');
    const { container } = render(<InviteHashRedirect />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [x] **Step 2: Run and confirm failure**

Run: `npx jest InviteHashRedirect.test.tsx`
Expected: FAIL — cannot resolve `@/components/InviteHashRedirect`.

- [x] **Step 3: Write the component**

Create `components/InviteHashRedirect.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import { inviteCallbackRedirect } from '@/lib/authRedirect';

/**
 * Rescues a misconfigured Supabase invite / password-recovery link whose session tokens land in
 * the URL hash at the bare app root instead of /auth/callback. Mounted on BOTH public entry
 * points such a link can reach: /login (which middleware redirects to, fragment intact) and the
 * marketing page at / (which middleware rewrites to /welcome, so the URL never changes and
 * /login never loads). Without this on the marketing page, an invited user would land on a
 * stranger's landing page with their one-time token sitting unused in the address bar, and the
 * failure would be silent — no error, no failed request.
 *
 * Renders nothing. It imports only lib/authRedirect, which has zero imports of its own, so it is
 * safe on a page that must not pull the Supabase browser client into its bundle.
 */
export default function InviteHashRedirect(): null {
  useEffect(() => {
    const target = inviteCallbackRedirect(window.location.hash);
    if (target) window.location.replace(target);
  }, []);
  return null;
}
```

- [x] **Step 4: Use it in `app/login/page.tsx`**

Delete the `useEffect` block and its comment, delete the now-unused
`import { inviteCallbackRedirect } from '@/lib/authRedirect';`, add
`import InviteHashRedirect from '@/components/InviteHashRedirect';`, and render it as the first
child of the returned wrapper `<div>`:

```tsx
  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-4">
      <InviteHashRedirect />
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-2xl">
```

Trim `useEffect` from the React import if nothing else in the file uses it — check before editing
that line; `useState` is still used.

- [x] **Step 5: Update the `lib/authRedirect.ts` header comment**

Replace the sentence describing the `/login` bounce as *the* mechanism. The new header:

```ts
// Supabase invite / password-recovery links are supposed to land on /auth/callback, which
// consumes the session tokens from the URL hash and prompts for a password. But if GoTrue
// falls back to the project Site URL (bare app root) — because the backend's redirect_to was
// unset or not on the Redirect-URLs allowlist — the tokens arrive in the hash at `/`.
//
// There are two ways that request is served, and BOTH must rescue it:
//   - `/library`, `/settings`, and every other page: middleware redirects to /login and the
//     fragment survives the 302.
//   - `/` with no session: middleware REWRITES to the marketing page, so the URL stays `/` and
//     /login never loads.
// components/InviteHashRedirect.tsx runs on both entry points and forwards such a hash to
// /auth/callback, so onboarding completes regardless of the Supabase redirect config.
```

- [x] **Step 6: Run the tests**

```bash
npx jest InviteHashRedirect.test.tsx
npm test
```

Expected: both PASS. `npm test` matters here because the login page changed.

- [x] **Step 7: Gates and commit**

```bash
npm run type-check && npm run lint && npm run format:check
git add components/InviteHashRedirect.tsx components/__tests__/InviteHashRedirect.test.tsx \
        app/login/page.tsx lib/authRedirect.ts
git commit -m "refactor: extract InviteHashRedirect for reuse on the marketing page"
```

---

## Task 7: The middleware rewrite

**Files:**
- Modify: `utils/supabase/middleware.ts`
- Create: `utils/supabase/__tests__/middleware.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: signed-out `/` is rewritten to `/welcome` (status 200, `x-middleware-rewrite` header,
  cookies preserved); every other signed-out page still redirects to `/login`; `/welcome` is
  publicly reachable.

**Testing note, verified:** the module reads `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` at *module load*, so every case must set env, call
`jest.resetModules()`, then `await import('../middleware')`. A static top-of-file import would
freeze one env configuration for the whole file.

- [x] **Step 1: Write the failing test**

Create `utils/supabase/__tests__/middleware.test.ts`:

```ts
const getUser = jest.fn();

jest.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, _opts: unknown) => ({
    auth: { getUser: () => getUser() },
  }),
}));

/**
 * middleware.ts reads process.env at module load, so each case must set env first and then
 * import the module fresh. A static import at the top of this file would pin one configuration
 * for every test.
 */
async function load(env: Record<string, string | undefined>) {
  jest.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import('../middleware');
  const { NextRequest } = await import('next/server');
  return {
    run: (path: string) =>
      mod.updateSession(new NextRequest(new Request(`https://shelfsprite.app${path}`))),
  };
}

const HOSTED = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://proj.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'pk_test',
};
const LOCAL = {
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
};

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
  getUser.mockReset();
});

function signedOut() {
  getUser.mockResolvedValue({ data: { user: null } });
}
function signedIn() {
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
}

describe('updateSession — signed out', () => {
  it('rewrites / to /welcome instead of redirecting', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    const res = await run('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toContain('/welcome');
  });

  it('still redirects every other page to /login', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    for (const path of ['/library', '/profile', '/settings', '/admin']) {
      const res = await run(path);
      expect(res.status).toBe(307);
      expect(res.headers.get('location')).toBe('https://shelfsprite.app/login');
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    }
  });

  it('lets /welcome through untouched', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    const res = await run('/welcome');
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('lets /login and /auth through untouched', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    for (const path of ['/login', '/auth/callback']) {
      const res = await run(path);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    }
  });

  it('rewrites only an exact /, not a path that merely starts with it', async () => {
    signedOut();
    const { run } = await load(HOSTED);
    const res = await run('/library/1');
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.status).toBe(307);
  });
});

describe('updateSession — signed in', () => {
  it('serves / from the dashboard: no rewrite, no redirect', async () => {
    signedIn();
    const { run } = await load(HOSTED);
    const res = await run('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
  });

  it('still bounces /login to /', async () => {
    signedIn();
    const { run } = await load(HOSTED);
    const res = await run('/login');
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://shelfsprite.app/');
  });
});

describe('updateSession — local mode (no Supabase env)', () => {
  it('never rewrites and never redirects', async () => {
    const { run } = await load(LOCAL);
    for (const path of ['/', '/welcome', '/library', '/login']) {
      const res = await run(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-rewrite')).toBeNull();
    }
    expect(getUser).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run and confirm failure**

Run: `npx jest middleware.test.ts`
Expected: FAIL — the `/` case currently redirects (307 to `/login`), so the rewrite assertions
fail.

- [x] **Step 3: Modify `utils/supabase/middleware.ts`**

Two edits.

First, add `/welcome` to the public list:

```ts
// Routes reachable without a session. /welcome is the marketing page: it is also served at / via
// the rewrite below, but stays directly reachable so it can be seen in local mode, where this
// middleware no-ops and / renders the dashboard.
const PUBLIC_PREFIXES = ['/login', '/auth', '/welcome'];
```

Second, add the rewrite branch immediately before the existing `if (!user && !isPublic)` block:

```ts
  if (!user && path === '/') {
    // A REWRITE, not a redirect: the URL people share is shelfsprite.app, and a redirect means
    // that is never what they land on. Exact '/' only — every other unauthenticated page still
    // goes to /login below.
    //
    // Built from supabaseResponse's cookies, not a bare NextResponse: getUser() above may have
    // just refreshed the session and written new cookies via setAll, and dropping them here
    // would silently throw away the refreshed token.
    //
    // The URL staying at / is also why components/InviteHashRedirect.tsx must be mounted on the
    // welcome page: /login never loads, so its invite-hash rescue never fires.
    const welcome = NextResponse.rewrite(new URL('/welcome', request.url), { request });
    supabaseResponse.cookies.getAll().forEach((cookie) => welcome.cookies.set(cookie));
    return welcome;
  }
  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }
```

Also update the function's docblock, whose current text says unauthenticated users are redirected
to `/login` full stop:

```ts
/**
 * Refresh the Supabase session cookie on each request and gate page routes: an unauthenticated
 * request for / is rewritten to the public marketing page at /welcome, and every other
 * unauthenticated page is redirected to /login. No-op in local mode (no Supabase env), so local
 * dev runs unauthenticated exactly as before.
 *
 * This middleware gates pages only. API routes do their own bearer authentication via withApi
 * and must stay excluded from the proxy matcher.
 */
```

- [x] **Step 4: Run the tests**

```bash
npx jest middleware.test.ts
npm test
```

Expected: both PASS.

- [x] **Step 5: Mutation check on the load-bearing cookie copy**

Delete the `supabaseResponse.cookies.getAll().forEach(...)` line and re-run. **Nothing will go
red** — no test covers it, because asserting on a refreshed-token cookie means driving the
`setAll` callback through a fake Supabase client. Restore the line and record the result honestly:
the cookie copy is currently documentation plus manual step 6 in Task 9, not engineering. Do not
weaken the comment to match, and do not invent a test that only asserts the line exists.

- [x] **Step 6: Gates and commit**

```bash
npm run type-check && npm run lint && npm run format:check
git add utils/supabase/middleware.ts utils/supabase/__tests__/middleware.test.ts
git commit -m "feat(middleware): rewrite signed-out / to the marketing page"
```

> After this commit and before Task 8 lands, signed-out `/` rewrites to a route that does not
> exist yet and will 404. That is expected and lasts exactly one task. Do not add a stub page to
> paper over it.

---

## Task 8: The marketing page

**Files:**
- Create: `app/(marketing)/layout.tsx`
- Create: `app/(marketing)/welcome/page.tsx`
- Create: `app/(marketing)/welcome/WaitlistForm.tsx`
- Create: `public/marketing/how-it-works.png`, `public/marketing/taste-profile.png` (placeholders)
- Create: `app/(marketing)/__tests__/welcome.test.tsx`

**Interfaces:**
- Consumes: `InviteHashRedirect` (Task 6); `POST /api/invite-requests` (Task 3);
  `Button`, `Field`, `Input` from `@/components/ui`; `BrandLogo`, `ShelfSprite` from
  `@/components/…`.
- Produces: the page at `/welcome`, reachable at `/` through the Task 7 rewrite.

**Hard constraints for this task**

- No `@/lib/api` and no `@/utils/supabase/client` anywhere under `app/(marketing)/`.
- `Field` takes a **function** as `children`, and a server component cannot pass a function to a
  client component. `Field` / `Input` therefore appear only inside `WaitlistForm.tsx`, which is
  `'use client'`. `Button`, `BrandLogo`, and `ShelfSprite` are fine in the server component.
- Screenshots go through `next/image` with explicit `width` / `height` and descriptive `alt`. The
  mascots are decorative and already render `alt="" aria-hidden`, so the adjacent copy must name
  what each step does.
- Responsive to 360px with no horizontal scroll at any width.
- No new motion. `globals.css` already zeroes animation durations under `prefers-reduced-motion`;
  do not add anything whose legibility depends on JS timing.
- The copy below is final. Transcribe it exactly. No em dashes.

- [x] **Step 0: Create the placeholder images — CONTROLLER STEP (no network in the sandbox)**

```bash
mkdir -p public/marketing
magick -size 1600x1000 xc:'#1f1b18' -fill '#948b81' -gravity center -pointsize 56 \
  -annotate 0 'Library screenshot placeholder' public/marketing/how-it-works.png
magick -size 1600x1000 xc:'#1f1b18' -fill '#948b81' -gravity center -pointsize 56 \
  -annotate 0 'Taste profile screenshot placeholder' public/marketing/taste-profile.png
```

Both are 1600x1000. Those are the intrinsic dimensions the page hardcodes, so the real screenshots
must be captured at the same size or the `width` / `height` props updated with them.

- [x] **Step 1: Write the failing test**

Create `app/(marketing)/__tests__/welcome.test.tsx`:

```tsx
/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import WelcomePage from '@/app/(marketing)/welcome/page';
import WaitlistForm from '@/app/(marketing)/welcome/WaitlistForm';

// next/image needs no network here, but it warns on unknown props in jsdom; render a plain img
// so the assertions read cleanly.
jest.mock('next/image', () => ({
  __esModule: true,
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: Record<string, unknown>) => <img {...(props as never)} />,
}));

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('welcome page', () => {
  it('renders all six sections', () => {
    render(<WelcomePage />);
    expect(
      screen.getByRole('heading', {
        name: /Your reading history is a CSV file sitting in your downloads folder\./i,
      })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Import$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Enrich$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Recommend$/ })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /The books it recommends exist/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /A profile built from evidence/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ask for an invite/i })).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('links to /login for people who already have an invite', () => {
    render(<WelcomePage />);
    const signIn = screen.getAllByRole('link', { name: /sign in/i });
    expect(signIn.length).toBeGreaterThan(0);
    signIn.forEach((a) => expect(a).toHaveAttribute('href', '/login'));
  });

  it('gives both screenshots descriptive alt text', () => {
    render(<WelcomePage />);
    expect(screen.getByAltText(/library/i)).toBeInTheDocument();
    expect(screen.getByAltText(/taste profile/i)).toBeInTheDocument();
  });
});

describe('waitlist form', () => {
  function fill(value = 'reader@example.com') {
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: /ask for an invite/i }));
  }

  it('replaces the form with a success message on 200', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    render(<WaitlistForm />);
    fill();
    expect(await screen.findByText(/on the list/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ask for an invite/i })).not.toBeInTheDocument();
  });

  it('posts the email and the honeypot field to /api/invite-requests', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    render(<WaitlistForm />);
    fill('  Reader@Example.COM ');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/invite-requests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ email: '  Reader@Example.COM ', website: '' });
  });

  it('shows an invalid-email message on 422 and keeps the form usable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422 });
    render(<WaitlistForm />);
    fill('nope');
    expect(await screen.findByRole('alert')).toHaveTextContent(/email address/i);
    expect(screen.getByRole('button', { name: /ask for an invite/i })).toBeEnabled();
  });

  it('shows a rate-limited message on 429', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });
    render(<WaitlistForm />);
    fill();
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many/i);
  });

  it('shows an error and leaves the form usable when the network fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    render(<WaitlistForm />);
    fill();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ask for an invite/i })).toBeEnabled();
  });

  it('has a honeypot input that is hidden from assistive technology', () => {
    const { container } = render(<WaitlistForm />);
    const honeypot = container.querySelector('input[name="website"]');
    expect(honeypot).not.toBeNull();
    expect(honeypot).toHaveAttribute('tabindex', '-1');
    expect(honeypot!.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
```

- [x] **Step 2: Run and confirm failure**

Run: `npx jest welcome.test.tsx`
Expected: FAIL — the page and form modules do not exist.

- [x] **Step 3: Write the route-group layout**

Create `app/(marketing)/layout.tsx`:

```tsx
/**
 * Chrome-free layout for the public marketing page. Deliberately omits NavBar, BottomNav,
 * LibraryGate, ReprofileBanner, UsageWarningBanner, FeedbackLauncher and the Providers wrapper:
 * every one of them assumes a session, and the entire audience for this route group is signed
 * out. The root layout still supplies <html>, the fonts and ToastProvider.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-base text-text">{children}</div>;
}
```

- [x] **Step 4: Write the waitlist form**

Create `app/(marketing)/welcome/WaitlistForm.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';

type State = 'idle' | 'submitting' | 'success' | 'error';

/**
 * Calls fetch('/api/invite-requests') directly rather than going through lib/api.ts. The API
 * client attaches a Supabase session token to every request, which would pull the Supabase
 * browser client into a bundle whose entire audience is signed out.
 *
 * The endpoint answers 200 {"ok": true} for a new email, a duplicate, and a honeypot alike, so
 * there is nothing here to branch on. Only 422 and 429 are distinguishable, on purpose.
 */
export default function WaitlistForm() {
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState('submitting');
    setMessage('');
    try {
      const res = await fetch('/api/invite-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, website }),
      });
      if (res.ok) {
        setState('success');
        return;
      }
      setState('error');
      if (res.status === 422) setMessage('That does not look like an email address.');
      else if (res.status === 429) setMessage('Too many requests from here. Try again in an hour.');
      else setMessage('Something went wrong on our end. Try again in a minute.');
    } catch {
      setState('error');
      setMessage('Could not reach the server. Check your connection and try again.');
    }
  }

  // Success replaces the form rather than sitting above it, so nobody submits twice.
  if (state === 'success') {
    return (
      <p className="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text">
        You are on the list. I will email you when there is a spot.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full max-w-md flex-col gap-3">
      <Field label="Email" error={state === 'error' ? message : undefined}>
        {(p) => (
          <Input
            {...p}
            type="email"
            name="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            disabled={state === 'submitting'}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
      </Field>

      {/* Honeypot. Real users never see or tab to this; anything in it means a bot. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input
          id="website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      <Button type="submit" size="lg" loading={state === 'submitting'}>
        {state === 'submitting' ? 'Sending…' : 'Ask for an invite'}
      </Button>
    </form>
  );
}
```

`Field` renders its `error` string inside a `<p role="alert">`, which is what the 422 / 429 /
network tests assert on. Do not add a second error element.

- [x] **Step 5: Write the page**

Create `app/(marketing)/welcome/page.tsx`. Copy is final; transcribe exactly.

```tsx
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
            middle of the catalog. The result is a profile that can say something more specific
            than &ldquo;likes literary fiction.&rdquo;
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
```

- [x] **Step 6: Run the tests**

```bash
npx jest welcome.test.tsx
npm test
```

Expected: both PASS.

- [x] **Step 7: Prove the Supabase client did not leak into the bundle**

```bash
grep -rn "lib/api\|utils/supabase/client\|@supabase" "app/(marketing)/"
```

Expected: **no output**. Any hit is a bug — the marketing bundle must not carry the Supabase
browser client.

- [x] **Step 8: Gates and commit**

```bash
npm run type-check && npm run lint && npm run format:check
git add "app/(marketing)/" public/marketing/
git commit -m "feat(marketing): public splash page with invite waitlist"
```

---

## Task 9: Full gate and manual verification

Not delegable. `npm run build` fails in a sandbox with no network because the root layout pulls
three Google Fonts, and steps 2 through 8 need a real browser and a real Supabase project.

- [x] **Step 1: Run every gate from the repository root**

```bash
npm run test:server
npm test
npm run type-check
npm run lint
npm run format:check
npm run build
```

All six must pass. `npm run build` is the only gate that catches Next segment-config and prerender
failures, and this change adds a route group and a rewrite.

- [x] **Step 2: Signed out, load `/`**

The splash renders and the address bar still reads `/`, not `/welcome`.

- [x] **Step 3: Submit the waitlist form**

Success state appears and replaces the form. Submit the same email again from a fresh load: still
succeeds, and the admin tab shows exactly one row.

> **Execution record (2026-08-24).** Task 1 step 7 had never been run: the migration was
> committed but `invite_requests` did not exist in the live Supabase project, so the endpoint
> 500d and the form showed its generic error. `npm run db:migrate` applied it, and the observed
> shape matches this plan's prediction: six columns, `email` / `status` / `created_at` NOT NULL,
> `created_at` defaulting to CURRENT_TIMESTAMP, `reviewed_at` and `reviewed_by` nullable.
>
> Steps 2, 3, 5, 6 and 8 were verified against a real Chrome over CDP driving the dev server.
> Step 6 only fires on a cold load: navigating to `/#access_token=...` from a page already at `/`
> is a same-document fragment change, so the effect never remounts. Steps 4 and 7 below need a
> signed-in session and are left for a human.
>
> One verification row (`verify-1787597769198@example.com`) is in `invite_requests` and can be
> declined from the Requests tab.

- [ ] **Step 4: Signed in, load `/`**

The dashboard renders, unchanged. Nav, bottom nav, and banners all present.

- [x] **Step 5: Signed out, load `/library`**

Still redirects to `/login`.

- [x] **Step 6: Load `/` with a fake Supabase auth hash**

Visit `/#access_token=fake&type=invite&refresh_token=fake`. It must forward to `/auth/callback`
with the fragment intact. This is the invite-hash trap from spec §3.2 and the single most
important manual check in this list — nothing in the automated suite covers the real middleware
and the real client together.

- [ ] **Step 7: Approve a request as admin**

Find the request in the Requests tab, approve it, confirm the invite email actually arrives and
the row flips to approved with a reviewer stamped.

- [x] **Step 8: Responsive check**

At 360px wide, the page must not scroll horizontally at any point down its full length.

- [ ] **Step 9 (deferred, not an implementer task): swap in the real screenshots**

Capture both against a throwaway local library seeded with fictional books via the
`isolated-local-env` skill, so no real reading history is published. Save at 1600x1000 over the
placeholders, or update the `width` / `height` props to match what was captured.

---

## Notes for the executor

- **Task order matters in two places.** Task 6 must land before Task 7, or the rewrite ships with
  the invite-hash rescue missing. Task 7 must land before Task 8 is *verified*, but between the
  two commits signed-out `/` 404s — expected, one task long, do not stub around it.
- **When production disagrees with this plan, read the source that produces reality** before
  honoring any stop instruction. Task 1 step 7's expected column shape is a hypothesis, not an
  oracle. Record what you observe.
- **A stop is cheap; a silent adaptation is not.** If a brief here disagrees with the repo, stop
  and report the observation rather than reconciling it yourself.
