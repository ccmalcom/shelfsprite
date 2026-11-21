/**
 * The home page's to-read prompt: when a reader with a long to-read shelf asks for new books,
 * the app first offers to pick their next read from that shelf. "Don't ask again" turns the
 * offer off; Settings turns it back on. The flag lives on user_settings as an opt-out, so a
 * missing row means the prompt is on. The shelf-size threshold is the client's
 * (NEXT_READ_PROMPT_MIN in lib/api.ts): it decides when to ask, the server only stores the answer.
 */
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { upsertUserSettings } from './settings';

export async function isNextReadPromptOn(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ off: schema.userSettings.nextReadPromptOff })
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  return !(rows[0]?.off ?? false);
}

export async function setNextReadPromptOn(db: Db, userId: string, on: boolean): Promise<void> {
  await upsertUserSettings(db, userId, { nextReadPromptOff: !on });
}
