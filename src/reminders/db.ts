import type { Sql } from '../db'
import { nextOccurrence, type Schedule } from './schedule'

/**
 * Inserts a reminder whose `next_due_at` is the first occurrence after `now`, and returns its id and that
 * instant. Throws when the schedule has none left. This is the one way a reminder is made in slice 6.1
 * (`pnpm reminder:add` and the tests); the agent's `set_reminder` will go through it too.
 */
export async function insertReminder(
  sql: Sql,
  r: { accountId: number; what: string; schedule: Schedule; now: Date; inboundId?: number },
): Promise<{ id: number; nextDueAt: Date }> {
  const nextDueAt = nextOccurrence(r.schedule, r.now)
  if (!nextDueAt) throw new Error('the schedule has no occurrence after now')
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO reminder (account_id, what, schedule, next_due_at, inbound_message_id)
    VALUES (${r.accountId}, ${r.what}, ${sql.json(r.schedule)}, ${nextDueAt}, ${r.inboundId ?? null})
    RETURNING id::int AS id`
  return { id: Number(row?.id), nextDueAt }
}

/**
 * A delivery status of `failed` for the wamid of a reminder's send: the row ends `failed` with Meta's code.
 * Returns whether the wamid is a reminder's (a status of any kind for it is not a reply's, so the caller stops there).
 */
export async function recordReminderStatus(
  sql: Sql,
  s: { wamid: string; status: string; code?: number },
): Promise<boolean> {
  const failed = s.status === 'failed'
  const rows = await sql`
    UPDATE reminder_send
    SET status = CASE WHEN ${failed} THEN 'failed' ELSE status END,
        error_code = CASE WHEN ${failed} THEN ${s.code ?? null}::int ELSE error_code END
    WHERE wamid = ${s.wamid}
    RETURNING id`
  return rows.length > 0
}
