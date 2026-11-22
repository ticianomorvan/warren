import type { Sql } from './db'
import {
  type BatchReminder,
  batchReminders,
  cancelReminder,
  countLiveReminders,
  insertReminder,
  type ReminderRow,
  reminderById,
} from './reminders/db'
import { MAX_REMINDERS } from './reminders/guard'
import { nextOccurrence } from './reminders/schedule'

/** What undoing one reminder of the batch did. */
export type ReminderUndone =
  /** The batch set it: it is cancelled now. */
  | { kind: 'reminder_removed'; reminder: ReminderRow }
  /** The batch cancelled it (one by one, or all with BAJA): it is back, with its next date worked out from now. */
  | { kind: 'reminder_restored'; reminder: ReminderRow }

/** The reminders a batch left behind and whether each still stands as the batch left it. Nothing is written yet. */
export interface ReminderPlan {
  /** What the batch set, with the live reminder that now holds it (a later cancel that was itself undone is a new row). */
  made: { row: BatchReminder; head: ReminderRow }[]
  /** What the batch cancelled, to bring back. */
  cancelled: BatchReminder[]
  /** Reminders that are no longer as the batch left them: the whole undo is refused. */
  moved: ReminderRow[]
}

/** The newest row of the chain of restores that starts at `id`: the one that stands today. */
async function headOf(tx: Sql, accountId: number, row: BatchReminder): Promise<BatchReminder> {
  let head = row
  for (let hop = 0; hop < 20; hop++) {
    const [next] = await tx<{ id: number }[]>`
      SELECT id::int AS id FROM reminder WHERE account_id = ${accountId} AND restores = ${head.id}`
    if (!next) return head
    const child = await reminderById(tx, accountId, next.id)
    if (!child) return head
    head = child
  }
  return head
}

/**
 * Reads what the batch did to reminders and whether it can be undone. A reminder is "as the batch left it" when, now:
 * - one the batch set is still live (or was cancelled by a later batch that was undone, which leaves a new live row);
 *   a one-off that has already been sent is not: there is nothing left to take back;
 * - one the batch cancelled can be brought back: it still has an occurrence after `now` (a one-off whose time has passed
 *   cannot come back), and the account stays within `MAX_REMINDERS`.
 * A reminder the batch set and cancelled itself is a net of nothing and is left out. The caller holds the account's reminders lock; the rows are read locked, so a sweep that is ending a one-off waits and the undo sees it ended.
 */
export async function planReminderUndo(
  tx: Sql,
  accountId: number,
  batch: number,
  now: Date,
): Promise<ReminderPlan> {
  const plan: ReminderPlan = { made: [], cancelled: [], moved: [] }
  for (const row of await batchReminders(tx, accountId, batch)) {
    if (row.inbound === batch && row.cancelledBy === batch) continue
    if (row.inbound === batch) {
      const head = await headOf(tx, accountId, row)
      if (!head.cancelled && head.nextDueAt) plan.made.push({ row, head })
      else plan.moved.push(row)
    } else if (nextOccurrence(row.schedule, now)) plan.cancelled.push(row)
    else plan.moved.push(row)
  }
  if (plan.cancelled.length > 0) {
    const live = await countLiveReminders(tx, accountId)
    if (live - plan.made.length + plan.cancelled.length > MAX_REMINDERS) {
      plan.moved.push(...plan.cancelled.splice(0))
    }
  }
  return plan
}

/** Writes what the plan says, append-only: what the batch set is cancelled, what it cancelled comes back as a new row. */
export async function applyReminderUndo(
  tx: Sql,
  o: { accountId: number; inboundId: number; now: Date },
  plan: ReminderPlan,
): Promise<ReminderUndone[]> {
  const items: ReminderUndone[] = []
  for (const { head } of plan.made) {
    if (!(await cancelReminder(tx, head.id, o.inboundId))) throw new Error('reminder is not live')
    items.push({ kind: 'reminder_removed', reminder: head })
  }
  for (const row of plan.cancelled) {
    const reminder = await insertReminder(tx, {
      accountId: o.accountId,
      what: row.what,
      schedule: row.schedule,
      now: o.now,
      inboundId: o.inboundId,
      restores: row.id,
    })
    items.push({ kind: 'reminder_restored', reminder })
  }
  return items
}
