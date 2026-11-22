import {
  endFact,
  type FactRow,
  findLive,
  forgetAll,
  MAX_FACTS,
  rememberFact,
} from '../domain/facts'
import {
  applyChanges,
  type ChangedField,
  changedFields,
  endVersion,
  insertMovements,
  lockLive,
  type MovementRow,
  supersede,
} from '../domain/movements'
import {
  countLiveReminders,
  endReminder,
  insertReminder,
  lockLiveReminder,
  type ReminderRow,
} from '../domain/reminders/db'
import { MAX_REMINDERS, scheduleOf } from '../domain/reminders/guard'
import { nextOccurrence } from '../domain/reminders/schedule'
import type { WriteCall } from './commands'
import type { Sql } from './db'
import { STORES, type Store, type UndoResult, undoLast } from './history'

/**
 * One write path under every channel: `applyCall` runs one of the nine writes inside the commit transaction and says what it did, as
 * data. The caller renders it (`describe`) and stores the turn. It knows of no conversation and no reply. Every query takes the
 * account; the account lock is held by the caller (`commit`), so the writes of one account are serialized, and a movement or a
 * reminder is still row-locked and checked to be the account's and live before it is changed (the second layer).
 */

export interface ApplyContext {
  /** The person. From the verified sender or the verified token, never from the call. */
  accountId: number
  /** The turn these writes belong to: reserved by `commit`, inserted last. Every version a call makes or ends carries it. */
  turnId: number
  /** The instant of the message (an undo brings reminders back from it). WhatsApp gives its own; an MCP request is now. */
  now: Date
  /** The stores this channel may undo. Default: all of them. */
  stores?: readonly Store[]
}

/** The one closed vocabulary of how a write came out. */
export const STATUSES = [
  'applied',
  'unchanged',
  'gone',
  'full',
  'past',
  'nothing',
  'expired',
  'restricted',
  'stale',
  'blocked',
] as const
export type Status = (typeof STATUSES)[number]

/** What a forget was asked for: an entity id, or the key's words. */
export type ForgetTarget = { id: number } | { key: string }

/** What a write did. `effect` is the kind of change it made, and null when it made none. */
export type Outcome =
  | { tool: 'log_movements'; status: 'applied'; effect: 'logged'; movements: MovementRow[] }
  /** The movement is not the person's, or no longer live: a turn that ran meanwhile changed it. Nothing was written. */
  | { tool: 'correct_movement'; status: 'gone'; effect: null; id: number }
  | { tool: 'correct_movement'; status: 'unchanged'; effect: null; old: MovementRow }
  | {
      tool: 'correct_movement'
      status: 'applied'
      effect: 'corrected'
      old: MovementRow
      /** The movement as the correction leaves it: the next version of the same entity. */
      next: MovementRow
      changed: ChangedField[]
    }
  | { tool: 'delete_movement'; status: 'gone'; effect: null; id: number }
  | { tool: 'delete_movement'; status: 'applied'; effect: 'deleted'; old: MovementRow }
  | ({ tool: 'undo_last'; effect: 'undone' | null } & UndoResult)
  | {
      tool: 'remember_fact'
      status: 'applied'
      effect: 'remembered'
      fact: FactRow
      before?: string
    }
  /** The same value was already stored: nothing was written. */
  | { tool: 'remember_fact'; status: 'unchanged'; effect: null; fact: FactRow }
  /** The account holds `MAX_FACTS` already: nothing was written. */
  | { tool: 'remember_fact'; status: 'full'; effect: null; max: number }
  | { tool: 'forget_fact'; status: 'applied'; effect: 'forgotten'; facts: FactRow[] }
  | { tool: 'forget_fact'; status: 'gone'; effect: null; target: ForgetTarget }
  | { tool: 'forget_all_confirmed'; status: 'applied'; effect: 'forgotten'; facts: FactRow[] }
  | { tool: 'forget_all_confirmed'; status: 'nothing'; effect: null }
  | { tool: 'set_reminder'; status: 'applied'; effect: 'reminded'; reminder: ReminderRow }
  /** The account holds `MAX_REMINDERS` already: nothing was written. */
  | { tool: 'set_reminder'; status: 'full'; effect: null; max: number }
  /** The schedule has no occurrence after the message's time (the guard said so; the commit point checks again). */
  | { tool: 'set_reminder'; status: 'past'; effect: null }
  | { tool: 'cancel_reminder'; status: 'applied'; effect: 'unreminded'; reminder: ReminderRow }
  /** Not the person's, or no longer live (sent, or cancelled by a turn that ran meanwhile): nothing was written. */
  | { tool: 'cancel_reminder'; status: 'gone'; effect: null; id: number }

export type OutcomeOf<T extends WriteCall['tool']> = Extract<Outcome, { tool: T }>

/** Runs one write inside the commit transaction and says what it did. A call is checked (`checkValues`, `checkTurn`) before it gets here. */
export async function applyCall(tx: Sql, ctx: ApplyContext, call: WriteCall): Promise<Outcome> {
  const { accountId, turnId } = ctx
  switch (call.tool) {
    case 'log_movements': {
      const movements = await insertMovements(tx, {
        accountId,
        turnId,
        now: ctx.now,
        movements: call.input.movements,
      })
      return { tool: call.tool, status: 'applied', effect: 'logged', movements }
    }
    case 'correct_movement': {
      const old = await lockLive(tx, accountId, call.input.id)
      if (!old) return { tool: call.tool, status: 'gone', effect: null, id: call.input.id }
      const values = applyChanges(old, call.input.changes)
      const changed = changedFields(old, values)
      if (changed.length === 0) return { tool: call.tool, status: 'unchanged', effect: null, old }
      const next = await supersede(tx, { accountId, turnId, now: ctx.now, old, next: values })
      return { tool: call.tool, status: 'applied', effect: 'corrected', old, next, changed }
    }
    case 'delete_movement': {
      const old = await lockLive(tx, accountId, call.input.id)
      if (!old) return { tool: call.tool, status: 'gone', effect: null, id: call.input.id }
      await endVersion(tx, old.version, turnId)
      return { tool: call.tool, status: 'applied', effect: 'deleted', old }
    }
    case 'undo_last': {
      const undone = await undoLast(tx, {
        accountId,
        turn: turnId,
        now: ctx.now,
        stores: ctx.stores ?? STORES,
      })
      return { tool: call.tool, effect: undone.status === 'applied' ? 'undone' : null, ...undone }
    }
    case 'remember_fact': {
      const { kind, key, value } = call.input
      const stored = await rememberFact(tx, { accountId, turnId, now: ctx.now, kind, key, value })
      if (stored.kind === 'full') {
        return { tool: call.tool, status: 'full', effect: null, max: MAX_FACTS }
      }
      if (stored.kind === 'unchanged') {
        return { tool: call.tool, status: 'unchanged', effect: null, fact: stored.fact }
      }
      return {
        tool: call.tool,
        status: 'applied',
        effect: 'remembered',
        fact: stored.fact,
        ...(stored.kind === 'updated' ? { before: stored.before } : {}),
      }
    }
    case 'forget_fact': {
      const { target } = call.input
      const found = await findLive(
        tx,
        accountId,
        'id' in target ? { id: target.id } : { key: target.key },
        {
          lock: true,
        },
      )
      const facts: FactRow[] = []
      for (const fact of found) if (await endFact(tx, fact.version, turnId)) facts.push(fact)
      return facts.length > 0
        ? { tool: call.tool, status: 'applied', effect: 'forgotten', facts }
        : { tool: call.tool, status: 'gone', effect: null, target }
    }
    case 'forget_all_confirmed': {
      const facts = await forgetAll(tx, accountId, turnId)
      return facts.length > 0
        ? { tool: call.tool, status: 'applied', effect: 'forgotten', facts }
        : { tool: call.tool, status: 'nothing', effect: null }
    }
    case 'set_reminder': {
      const schedule = scheduleOf(call.input, ctx.now)
      if (typeof schedule === 'string' || !schedule || !nextOccurrence(schedule, ctx.now)) {
        return { tool: call.tool, status: 'past', effect: null }
      }
      if ((await countLiveReminders(tx, accountId)) >= MAX_REMINDERS) {
        return { tool: call.tool, status: 'full', effect: null, max: MAX_REMINDERS }
      }
      const reminder = await insertReminder(tx, {
        accountId,
        turnId,
        what: call.input.what,
        schedule,
        now: ctx.now,
      })
      return { tool: call.tool, status: 'applied', effect: 'reminded', reminder }
    }
    case 'cancel_reminder': {
      const reminder = await lockLiveReminder(tx, accountId, call.input.id)
      if (!reminder || !(await endReminder(tx, reminder.version, turnId))) {
        return { tool: call.tool, status: 'gone', effect: null, id: call.input.id }
      }
      return { tool: call.tool, status: 'applied', effect: 'unreminded', reminder }
    }
  }
}
