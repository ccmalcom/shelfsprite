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
