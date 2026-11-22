import type { Action, FactKind, Movement, RecentMovement } from './agent/schema'
import type { Sql } from './db'
import {
  type FactRow,
  findLive,
  forgetFact,
  lockFacts,
  type Remembered,
  rememberFact,
} from './facts'
import { insertMovements, lockLive, type MovementRow, softDelete, supersede } from './ledger'
import { applyChanges, type ChangedField, changedFields } from './movement'
import { type UndoOutcome, undoLast } from './undo'

/** The six calls that change what Warren keeps, whoever sends them: the agent over WhatsApp or a client over MCP. */
export type WriteCall = Extract<
  Action,
  {
    tool:
      | 'log_movements'
      | 'correct_movement'
      | 'delete_movement'
      | 'undo_last'
      | 'remember_fact'
      | 'forget_fact'
  }
>

export const WRITE_TOOLS = [
  'log_movements',
  'correct_movement',
  'delete_movement',
  'undo_last',
  'remember_fact',
  'forget_fact',
] as const

export interface ApplyContext {
  /** The person. From the verified sender or the verified token, never from the call. */
  accountId: number
  /** The batch: the `inbound_message` row this call's changes are linked to (the message, or an MCP request's row). */
  batchId: number
  /** The position of the first row this call inserts in its batch: a message may log, correct and log again. Default 0. */
  position?: number
}

/** What a write did, as data: the caller renders it (WhatsApp's reply from templates, MCP's structured result). */
export type Outcome =
  | { tool: 'log_movements'; kind: 'applied'; movements: Movement[]; ids: number[]; rows: number }
  /** The movement is not the person's, or no longer live: a message that ran meanwhile changed it. Nothing was written. */
  | { tool: 'correct_movement'; kind: 'gone'; id: number; rows: 0 }
  | { tool: 'correct_movement'; kind: 'unchanged'; old: MovementRow; rows: 0 }
  | {
      tool: 'correct_movement'
      kind: 'applied'
      old: MovementRow
      /** The movement as the correction leaves it, and the id of its new row (the old one is replaced, never edited). */
      next: RecentMovement
      id: number
      changed: ChangedField[]
      rows: 1
    }
  | { tool: 'delete_movement'; kind: 'gone'; id: number; rows: 0 }
  | { tool: 'delete_movement'; kind: 'applied'; old: MovementRow; rows: 0 }
  | { tool: 'undo_last'; undo: UndoOutcome; rows: 0 }
  | { tool: 'remember_fact'; stored: Remembered; kind: FactKind; key: string; rows: 0 }
  /** `gone` is what was forgotten; `id` and `key` are what was asked for (0 and "" when unused), for the refusal when nothing was. */
  | { tool: 'forget_fact'; gone: FactRow[]; id: number; key: string; rows: 0 }

/**
 * Runs one write inside a transaction that already holds the batch's row, and says what it did. The one write path of both
 * channels (docs/mcp-spec.md, Design 4): every query takes the account; a movement is locked (`FOR UPDATE`) and checked to be
 * the account's and still live before it is changed, so two requests that change the same movement at once are serialized
 * and the second finds it gone; a fact takes the account's advisory lock; an undo takes its own and refuses a batch that is
 * no longer as it was left. A call is validated before it gets here (`checkCall` for WhatsApp, `checkInput` for MCP).
 * Nothing in this function knows of a conversation or a reply.
 */
export async function applyCall(tx: Sql, ctx: ApplyContext, call: WriteCall): Promise<Outcome> {
  const { accountId, batchId } = ctx
  switch (call.tool) {
    case 'log_movements': {
      const { movements } = call.input
      const ids = await insertMovements(tx, {
        accountId,
        inboundId: batchId,
        movements,
        firstPosition: ctx.position ?? 0,
      })
      return { tool: call.tool, kind: 'applied', movements, ids, rows: movements.length }
    }
    case 'correct_movement': {
      const old = await lockLive(tx, accountId, call.input.id)
      if (!old) return { tool: call.tool, kind: 'gone', id: call.input.id, rows: 0 }
      const next = applyChanges(old, call.input.changes)
      const changed = changedFields(old, next)
      if (changed.length === 0) return { tool: call.tool, kind: 'unchanged', old, rows: 0 }
      const id = await supersede(tx, {
        accountId,
        inboundId: batchId,
        old,
        next,
        position: ctx.position ?? 0,
      })
      return { tool: call.tool, kind: 'applied', old, next, id, changed, rows: 1 }
    }
    case 'delete_movement': {
      const old = await lockLive(tx, accountId, call.input.id)
      if (!old) return { tool: call.tool, kind: 'gone', id: call.input.id, rows: 0 }
      await softDelete(tx, old.id, batchId)
      return { tool: call.tool, kind: 'applied', old, rows: 0 }
    }
    case 'undo_last':
      return {
        tool: call.tool,
        undo: await undoLast(tx, { accountId, inboundId: batchId }),
        rows: 0,
      }
    case 'remember_fact': {
      const { kind, key, value } = call.input
      return {
        tool: call.tool,
        stored: await rememberFact(tx, { accountId, inboundId: batchId, kind, key, value }),
        kind,
        key,
        rows: 0,
      }
    }
    case 'forget_fact': {
      const { id, key } = call.input
      await lockFacts(tx, accountId)
      // By id or by key: either way only the account's own live facts are looked up.
      const found = await findLive(tx, accountId, id > 0 ? { id } : { key }, { lock: true })
      const gone: FactRow[] = []
      for (const fact of found) {
        if (await forgetFact(tx, fact.id, batchId)) gone.push(fact)
      }
      return { tool: call.tool, gone, id, key, rows: 0 }
    }
  }
}
