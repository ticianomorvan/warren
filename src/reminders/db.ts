import type { Sql } from '../core/db'
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

/**
 * A stored row as a `ReminderRow`, or null (logged) when its schedule no longer parses: one bad row must not fail every message
 * of the person that reads their reminders (the sender does the same: `reminder_bad_schedule`).
 */
function toRow(r: RawRow): ReminderRow | null {
  const schedule = ScheduleSchema.safeParse(r.schedule)
  if (!schedule.success) {
    log('reminder_bad_schedule', { reminder: r.id, error: schedule.error.message }, 'error')
    return null
  }
  return { id: r.id, what: r.what, schedule: schedule.data, nextDueAt: r.next_due_at }
}

const present = <T>(x: T | null): x is T => x !== null

/** Not cancelled: the only reminders that count. A finished one-off (`next_due_at` null) is not live either. */
const LIVE = `cancelled_at IS NULL AND next_due_at IS NOT NULL`

const columns = (sql: Sql) => sql`id::int AS id, what, schedule, next_due_at`

/**
 * One writer at a time per account over its reminders: the cap, a cancel and an undo are decided after this. Taken once, by the
 * caller of each (`applyReminderCall`, `undoLast`); the functions below assume it is held.
 */
export async function lockReminders(sql: Sql, accountId: number): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(7203005, ${accountId}::int)`
}

/** The account's live reminders, the next to come first: what the model is shown and "¿qué recordatorios tengo?" lists. */
export async function liveReminders(sql: Sql, accountId: number): Promise<ReminderRow[]> {
  const rows = await sql<RawRow[]>`
    SELECT ${columns(sql)} FROM reminder
    WHERE account_id = ${accountId} AND ${sql.unsafe(LIVE)}
    ORDER BY next_due_at, id`
  return rows.map(toRow).filter(present)
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

/**
 * How many live reminders count toward the cap: the ones that parse, like the ones anybody can see, list or cancel. A row whose
 * schedule is corrupt is invisible, so it must not take a place nobody can free.
 */
export async function countLiveReminders(sql: Sql, accountId: number): Promise<number> {
  return (await liveReminders(sql, accountId)).length
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
  return { id: Number(row?.id), what: tidyWhat(r.what), schedule: r.schedule, nextDueAt }
}

// ---- Undo. A write batch is the inbound message that made the changes (see undo.ts).

/** A reminder row in any state, with who inserted and cancelled it. */
export interface BatchReminder extends ReminderRow {
  /** The message that inserted the row. */
  inbound: number | null
  cancelledBy: number | null
  cancelled: boolean
}

type BatchRaw = RawRow & { inbound: number | null; cancelled_by: number | null }

const batchColumns = (sql: Sql) =>
  sql`${columns(sql)}, inbound_message_id::int AS inbound, cancelled_by::int AS cancelled_by`

function toBatchRow(r: BatchRaw): BatchReminder | null {
  const row = toRow(r)
  return (
    row && {
      ...row,
      inbound: r.inbound,
      cancelledBy: r.cancelled_by,
      cancelled: r.cancelled_by !== null,
    }
  )
}

/**
 * Every reminder row of the account the batch inserted (not as an undo's restore) or cancelled, oldest first, locked: a sweep that
 * is finishing one of them waits (or has finished: the row is read as it is then), so the undo never races it.
 */
export async function batchReminders(
  sql: Sql,
  accountId: number,
  batch: number,
): Promise<BatchReminder[]> {
  const rows = await sql<BatchRaw[]>`
    SELECT ${batchColumns(sql)} FROM reminder
    WHERE account_id = ${accountId}
      AND ((inbound_message_id = ${batch} AND restores IS NULL) OR cancelled_by = ${batch})
    ORDER BY id FOR UPDATE`
  return rows.map(toBatchRow).filter(present)
}

/** One reminder row of the account in any state, locked (see `batchReminders`). */
export async function reminderById(
  sql: Sql,
  accountId: number,
  id: number,
): Promise<BatchReminder | null> {
  const [r] = await sql<BatchRaw[]>`
    SELECT ${batchColumns(sql)} FROM reminder WHERE account_id = ${accountId} AND id = ${id} FOR UPDATE`
  return r ? toBatchRow(r) : null
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
