import type { Sql } from '../db'
import { log } from '../log'
import { nextOccurrence, type Schedule } from './schedule'

/** The template's language, as Meta names it. */
export const TEMPLATE_LANGUAGE = 'es_AR'

/** Meta's "more than 24 hours since the person last wrote". */
export const OUTSIDE_WINDOW = 131047

/**
 * What a reminder says, on one line: runs of whitespace (a newline, a tab, five spaces) become one space. A template's
 * parameter may hold none of those, and the person's words are not changed by it.
 */
export const tidyWhat = (what: string): string => what.replace(/\s+/g, ' ').trim()

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
    VALUES (${r.accountId}, ${tidyWhat(r.what)}, ${sql.json(r.schedule)}, ${nextDueAt}, ${r.inboundId ?? null})
    RETURNING id::int AS id`
  return { id: Number(row?.id), nextDueAt }
}

/**
 * A delivery status for the wamid of a reminder's send. Returns whether the wamid is a reminder's (the caller then
 * stops: it is not a reply's). Only a `sent` row changes, and only on `failed`, in one guarded transaction, so a
 * redelivered webhook changes nothing the second time:
 * - a text that got 131047 (the 24 h window had closed after all) becomes `retry_template`; the sweep sends the
 *   template once;
 * - any other failure ends it `failed` with Meta's code.
 * Either way the send no longer counts in `sent_count`.
 */
export async function recordReminderStatus(
  sql: Sql,
  s: { wamid: string; status: string; code?: number | undefined },
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: number; reminder_id: number; kind: string; status: string }[]>`
      SELECT id::int AS id, reminder_id::int AS reminder_id, kind, status FROM reminder_send
      WHERE wamid = ${s.wamid} FOR UPDATE`
    if (!row) return false
    if (s.status !== 'failed' || row.status !== 'sent') return true
    const retry = row.kind === 'text' && s.code === OUTSIDE_WINDOW
    const status = retry ? 'retry_template' : 'failed'
    await tx`UPDATE reminder_send SET status = ${status}, error_code = ${s.code ?? null} WHERE id = ${row.id}`
    await tx`UPDATE reminder SET sent_count = sent_count - 1 WHERE id = ${row.reminder_id}`
    log(
      'reminder_status_failed',
      { send: row.id, reminder: row.reminder_id, code: s.code, status },
      'error',
    )
    return true
  })
}
