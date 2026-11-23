import type { Sql } from '../../core/db'
import { log } from '../../log'
import { tidyWhat } from './guard'
import { nextOccurrence, type Schedule, ScheduleSchema } from './schedule'

/** A live reminder as the model, the record and the list see it. `id` is the entity id; `version` is the row of the version. */
export interface ReminderRow {
  id: number
  version: number
  what: string
  schedule: Schedule
  /** The next occurrence; null once it has finished (a one-off that was sent). */
  nextDueAt: Date | null
  loggedAt: Date
}

interface RawRow {
  id: number
  version: number
  what: string
  schedule: unknown
  next_due_at: Date | null
  loggedAt: Date
}

/**
 * A stored row as a `ReminderRow`, or null (logged) when its schedule no longer parses: one bad row must not fail every message
 * of the person that reads their reminders (the sender does the same: `reminder_bad_schedule`).
 */
export function toRow(r: RawRow): ReminderRow | null {
  const schedule = ScheduleSchema.safeParse(r.schedule)
  if (!schedule.success) {
    log('reminder_bad_schedule', { reminder: r.id, error: schedule.error.message }, 'error')
    return null
  }
  return {
    id: r.id,
    version: r.version,
    what: r.what,
    schedule: schedule.data,
    nextDueAt: r.next_due_at,
    loggedAt: r.loggedAt,
  }
}

const present = <T>(x: T | null): x is T => x !== null

/**
 * Scheduled: live (not ended) and still to fire. The only reminders that count, list or can be cancelled. A finished one-off is
 * live too (`ended_at IS NULL`, as the schema says) but has `next_due_at` NULL, so it is not scheduled: the one place that says so.
 */
export const SCHEDULED = (sql: Sql) => sql`ended_at IS NULL AND next_due_at IS NOT NULL`

const columns = (sql: Sql) =>
  sql`entity_id AS id, id AS version, what, schedule, next_due_at, logged_at AS "loggedAt"`

/** The account's live reminders, the next to come first: what the model is shown and "¿qué recordatorios tengo?" lists. */
export async function liveReminders(sql: Sql, accountId: number): Promise<ReminderRow[]> {
  const rows = await sql<RawRow[]>`
    SELECT ${columns(sql)} FROM reminder
    WHERE account_id = ${accountId} AND ${SCHEDULED(sql)}
    ORDER BY next_due_at, reminder.id`
  return rows.map(toRow).filter(present)
}

/** One live reminder of the account, locked, or null: only the account's own, and only while it is live. */
export async function lockLiveReminder(
  sql: Sql,
  accountId: number,
  entityId: number,
): Promise<ReminderRow | null> {
  const [row] = await sql<RawRow[]>`
    SELECT ${columns(sql)} FROM reminder
    WHERE entity_id = ${entityId} AND account_id = ${accountId} AND ${SCHEDULED(sql)}
    FOR UPDATE`
  return row ? toRow(row) : null
}

/** Ends a version in a turn (a cancel, or an undo of a set). Never removes the row; false when it was not live. */
export async function endReminder(sql: Sql, version: number, turnId: number): Promise<boolean> {
  const ended = await sql`
    UPDATE reminder SET ended_in = ${turnId}, ended_at = now()
    WHERE id = ${version} AND ended_at IS NULL RETURNING id`
  return ended.length > 0
}

/**
 * How many live reminders count toward the cap: the ones that parse, like the ones anybody can see, list or cancel. A row whose
 * schedule is corrupt is invisible, so it must not take a place nobody can free.
 */
export async function countLiveReminders(sql: Sql, accountId: number): Promise<number> {
  return (await liveReminders(sql, accountId)).length
}

/**
 * Inserts a reminder whose `next_due_at` is the first occurrence after `now`, and returns it. Throws when the schedule has none
 * left. The one way a reminder is made (`set_reminder`, an undo's restore, `pnpm reminder:add`, the tests); `entity` makes it the
 * next version of a reminder: it keeps its id and the time it was first set.
 */
export async function insertReminder(
  sql: Sql,
  r: {
    accountId: number
    turnId: number
    what: string
    schedule: Schedule
    /** What the first occurrence is counted from. */
    now: Date
    /** When it was set, for `logged_at` (default `now`). */
    at?: Date
    entity?: { id: number; loggedAt: Date }
  },
): Promise<ReminderRow> {
  const nextDueAt = nextOccurrence(r.schedule, r.now)
  if (!nextDueAt) throw new Error('the schedule has no occurrence after now')
  const [row] = await sql<RawRow[]>`
    INSERT INTO reminder (${r.entity ? sql`entity_id,` : sql``} logged_at, account_id, made_in, what, schedule, next_due_at)
    VALUES (${r.entity ? sql`${r.entity.id},` : sql``} ${r.entity?.loggedAt ?? r.at ?? r.now}, ${r.accountId}, ${r.turnId}, ${tidyWhat(r.what)}, ${sql.json(r.schedule)}, ${nextDueAt})
    RETURNING ${columns(sql)}`
  return toRow(row as RawRow) as ReminderRow
}
