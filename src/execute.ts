import type { Sql } from './db'
import {
  insertMovements,
  lockLive,
  type MovementRow,
  queryTotals,
  recentMovements,
  softDelete,
  supersede,
} from './ledger'
import { applyChanges, changedFields } from './movement'
import type { Command } from './parse'
import {
  REPLY_GONE,
  REPLY_NO_CHANGES,
  type RenderOptions,
  renderCorrection,
  renderDeletion,
  renderQuery,
  renderQuestion,
  renderReply,
  renderUnchanged,
} from './render'
import { type Numbered, resolveTarget } from './resolve'
import { periodRange } from './time'

export interface ExecuteInput {
  accountId: number
  /** The inbound message that carries the command; what it creates or ends is linked to it. */
  inboundId: number
  command: Command
  /** The Argentine day of the message. */
  today: string
  /** What the person wrote; `resolveTarget` checks the model's pick against it. */
  text: string
  /** The list the model was shown when it parsed the message (newest first). */
  recent: MovementRow[]
  render?: RenderOptions
}

/**
 * Runs a command against the ledger and returns the reply to store. It runs inside the commit
 * transaction, after the commit guard has passed, so a replay or a crash cannot apply it twice.
 * A correction or delete locks its target and checks it is still live first: a message that ran
 * between the parse and now may already have changed or deleted it, and then nothing is applied.
 */
export async function execute(tx: Sql, i: ExecuteInput): Promise<string> {
  const { command, today } = i
  switch (command.type) {
    case 'log':
      await insertMovements(tx, {
        accountId: i.accountId,
        inboundId: i.inboundId,
        movements: command.movements,
      })
      return renderReply(command, today, i.render)
    case 'help':
    case 'off_topic':
      return renderReply(command, today, i.render)
    case 'correct':
    case 'delete': {
      if (command.type === 'correct' && Object.values(command.changes).every((v) => v === null)) {
        return REPLY_NO_CHANGES
      }
      // The pick was made on the list the model saw. If the ledger moved since, the numbers mean
      // other movements now: ask, listing the list as it is.
      const fresh = await recentMovements(tx, i.accountId)
      if (fresh.length !== i.recent.length || fresh.some((m, k) => m.id !== i.recent[k]?.id)) {
        const numbered: Numbered[] = fresh.map((movement, k) => ({ number: k + 1, movement }))
        return renderQuestion(numbered.slice(0, 3), today)
      }
      const target = resolveTarget(command, i.recent, { text: i.text, today })
      if (target.kind === 'ask') return renderQuestion(target.candidates, today)
      const old = await lockLive(tx, i.accountId, target.movement.id)
      if (!old) return REPLY_GONE
      if (command.type === 'delete') {
        await softDelete(tx, old.id, i.inboundId)
        return renderDeletion(old, today)
      }
      const next = applyChanges(old, command.changes)
      const changed = changedFields(old, next)
      if (changed.length === 0) return renderUnchanged(old, today)
      await supersede(tx, { accountId: i.accountId, inboundId: i.inboundId, old, next })
      return renderCorrection(old, next, changed, today)
    }
    case 'query': {
      const totals = await queryTotals(tx, i.accountId, {
        direction: command.direction,
        category: command.category,
        payment: command.payment,
        range: periodRange(command.period, today),
      })
      return renderQuery(command, totals)
    }
  }
}
