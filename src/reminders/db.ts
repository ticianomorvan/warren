import type { Sql } from '../db'
import { log } from '../log'
import { nextOccurrence, type Schedule, ScheduleSchema } from './schedule'

/** The template's language, as Meta names it. */
export const TEMPLATE_LANGUAGE = 'es_AR'

/** Meta's "more than 24 hours since the person last wrote". */
export const OUTSIDE_WINDOW = 131047

/**
 * What a reminder says, on one line: runs of whitespace (a newline, a tab, five spaces) become one space. A template's
 * parameter may hold none of those, and the person's words are not changed by it.
 */
export const tidyWhat = (what: string): string => what.replace(/\s+/g, ' ').trim()

/** A live reminder as the model, the record and the list see it. */
export interface ReminderRow {
  id: number
  what: string
  schedule: Schedule
  /** The next occurrence; null once it has finished (a one-off that was sent). */
  nextDueAt: Date | null
}

interface RawRow {
  id: number
  what: string
  schedule: unknown
  next_due_at: Date | null
}

const toRow = (r: RawRow): ReminderRow => ({
  id: r.id,
  what: r.what,
  schedule: ScheduleSchema.parse(r.schedule),
  nextDueAt: r.next_due_at,
})

/** Not cancelled: the only reminders that count. A finished one-off (`next_due_at` null) is not live either. */
const LIVE = `cancelled_at IS NULL AND next_due_at IS NOT NULL`

const columns = (sql: Sql) => sql`id::int AS id, what, schedule, next_due_at`

/** One writer at a time per account over its reminders: the cap is checked after this. */
export async function lockReminders(sql: Sql, accountId: number): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(7203005, ${accountId}::int)`
}

/** The account's live reminders, the next to come first: what the model is shown and "¿qué recordatorios tengo?" lists. */
export async function liveReminders(sql: Sql, accountId: number): Promise<ReminderRow[]> {
  const rows = await sql<RawRow[]>`
    SELECT ${columns(sql)} FROM reminder
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    ORDER BY next_due_at, id`
  return rows.map(toRow)
}

/** One live reminder of the account, locked, or null: only the account's own, and only while it is live. */
export async function lockLiveReminder(
  sql: Sql,
  accountId: number,
  id: number,
): Promise<ReminderRow | null> {
  const [row] = await sql<RawRow[]>`
    SELECT ${columns(sql)} FROM reminder
    WHERE id = ${id} AND account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    FOR UPDATE`
  return row ? toRow(row) : null
}

/** Stamps a reminder as cancelled by the message that asked. Never removes the row. False when it was not live. */
export async function cancelReminder(sql: Sql, id: number, inboundId: number): Promise<boolean> {
  const stamped = await sql`
    UPDATE reminder SET cancelled_at = now(), cancelled_by = ${inboundId}
    WHERE id = ${id} AND ${sql.unsafe(LIVE)} RETURNING id`
  return stamped.length > 0
}

/** Cancels every live reminder of the account ("BAJA"); returns them as they were. */
export async function cancelAllReminders(
  sql: Sql,
  accountId: number,
  inboundId: number,
): Promise<ReminderRow[]> {
  await lockReminders(sql, accountId)
  const rows = await sql<RawRow[]>`
    UPDATE reminder SET cancelled_at = now(), cancelled_by = ${inboundId}
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    RETURNING ${columns(sql)}`
  return rows.map(toRow).sort((a, b) => a.id - b.id)
}

export async function countLiveReminders(sql: Sql, accountId: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM reminder WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}`
  return row?.n ?? 0
}

/**
 * Inserts a reminder whose `next_due_at` is the first occurrence after `now`, and returns it. Throws when the schedule
 * has none left. The one way a reminder is made (`set_reminder`, `pnpm reminder:add`, the tests); `restores` is set by an undo.
 */
export async function insertReminder(
  sql: Sql,
  r: {
    accountId: number
    what: string
    schedule: Schedule
    now: Date
    inboundId?: number
    restores?: number
  },
): Promise<ReminderRow> {
  const nextDueAt = nextOccurrence(r.schedule, r.now)
  if (!nextDueAt) throw new Error('the schedule has no occurrence after now')
  const [row] = await sql<RawRow[]>`
    INSERT INTO reminder (account_id, what, schedule, next_due_at, inbound_message_id, restores)
    VALUES (${r.accountId}, ${tidyWhat(r.what)}, ${sql.json(r.schedule)}, ${nextDueAt}, ${r.inboundId ?? null}, ${r.restores ?? null})
    RETURNING ${columns(sql)}`
  return toRow(row as RawRow)
}

// ---- Undo. A write batch is the inbound message that made the changes (see undo.ts).

/** A reminder row a batch inserted or cancelled, in any state. */
export interface BatchReminder extends ReminderRow {
  /** The message that inserted the row. */
  inbound: number | null
  cancelledBy: number | null
  cancelled: boolean
}

/** Every reminder row of the account the batch inserted (not as an undo's restore) or cancelled, oldest first. */
export async function batchReminders(
  sql: Sql,
  accountId: number,
  batch: number,
): Promise<BatchReminder[]> {
  const rows = await sql<(RawRow & { inbound: number | null; cancelled_by: number | null })[]>`
    SELECT ${columns(sql)}, inbound_message_id::int AS inbound, cancelled_by::int AS cancelled_by
    FROM reminder
    WHERE account_id = ${accountId}
      AND ((inbound_message_id = ${batch} AND restores IS NULL) OR cancelled_by = ${batch})
    ORDER BY id`
  return rows.map((r) => ({
    ...toRow(r),
    inbound: r.inbound,
    cancelledBy: r.cancelled_by,
    cancelled: r.cancelled_by !== null,
  }))
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

/** One reminder row of the account in any state, with who inserted and cancelled it. */
export async function reminderById(
  sql: Sql,
  accountId: number,
  id: number,
): Promise<BatchReminder | null> {
  const [r] = await sql<(RawRow & { inbound: number | null; cancelled_by: number | null })[]>`
    SELECT ${columns(sql)}, inbound_message_id::int AS inbound, cancelled_by::int AS cancelled_by
    FROM reminder WHERE account_id = ${accountId} AND id = ${id}`
  return r
    ? {
        ...toRow(r),
        inbound: r.inbound,
        cancelledBy: r.cancelled_by,
        cancelled: r.cancelled_by !== null,
      }
    : null
}
