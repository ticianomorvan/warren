import { endFact, type FactRow, findLive, MAX_FACTS, rememberFact } from '../domain/facts'
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
import type { WriteCall } from './commands'
import type { Sql } from './db'
import { type UndoResult, undoLast } from './history'

/**
 * One write path: `applyCall` runs one of the writes inside the commit transaction and says what it did, as data. The caller renders
 * it (`describe`) and stores the turn. Every query takes the account; the account lock is held by the caller (`commit`), so the
 * writes of one account are serialized, and a movement is still row-locked and checked to be the account's and live before it is
 * changed (the second layer).
 */

export interface ApplyContext {
  /** The person. From the verified token, never from the call. */
  accountId: number
  /** The turn these writes belong to: reserved by `commit`, inserted last. Every version a call makes or ends carries it. */
  turnId: number
  /** The instant of the call: `logged_at` of what is new, and what an undo counts its window from. */
  at: Date
}

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

export type OutcomeOf<T extends WriteCall['tool']> = Extract<Outcome, { tool: T }>

/** Runs one write inside the commit transaction and says what it did. A call is checked (`checkValues`) before it gets here. */
export async function applyCall(tx: Sql, ctx: ApplyContext, call: WriteCall): Promise<Outcome> {
  const { accountId, turnId } = ctx
  switch (call.tool) {
    case 'log_movements': {
      const movements = await insertMovements(tx, {
        accountId,
        turnId,
        now: ctx.at,
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
      const next = await supersede(tx, { accountId, turnId, now: ctx.at, old, next: values })
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
        at: ctx.at,
      })
      return { tool: call.tool, effect: undone.status === 'applied' ? 'undone' : null, ...undone }
    }
    case 'remember_fact': {
      const { kind, key, value } = call.input
      const stored = await rememberFact(tx, { accountId, turnId, now: ctx.at, kind, key, value })
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
  }
}
