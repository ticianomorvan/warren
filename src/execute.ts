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
  REPLY_ONE_THING,
  type RenderOptions,
  renderCorrection,
  renderDeletion,
  renderQuery,
  renderQuestion,
  renderReply,
  renderUnchanged,
} from './render'
import { answerNumber, type Numbered, positionsIn, resolveTarget } from './resolve'
import type { Executed, Previous } from './store'
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
  /** The sender's previous exchange, when it was recent and committed. */
  previous?: Previous | null
  render?: RenderOptions
}

const say = (reply: string): Executed => ({ reply })

const question = (candidates: Numbered[], today: string): Executed => ({
  reply: renderQuestion(candidates, today),
  asked: candidates.map((c) => c.number),
})

/**
 * When the message is only the answer to the `¿Cuál?` question we just asked ("2", "el primero"),
 * the previous message's action aimed at that row, whatever the model made of the short text. The
 * model wins only when it returned a confident correction with changes of its own.
 */
function answerToQuestion(i: ExecuteInput): { command: Command; movement: MovementRow } | null {
  const { previous, command } = i
  const asked = previous?.askedNumbers
  const before = previous?.command
  if (!asked?.length || !before || (before.type !== 'correct' && before.type !== 'delete')) {
    return null
  }
  if (
    command.type === 'correct' &&
    command.confidence === 'high' &&
    Object.values(command.changes).some((v) => v !== null)
  ) {
    return null
  }
  const n = answerNumber(i.text, asked)
  const movement = n === null ? undefined : i.recent[n - 1]
  return movement ? { command: before, movement } : null
}

/**
 * Runs a command against the ledger and returns the reply to store. It runs inside the commit
 * transaction, after the commit guard has passed, so a replay or a crash cannot apply them twice.
 * A correction or delete locks its target and checks it is still live first: a message that ran
 * between the parse and now may already have changed or deleted it, and then nothing is applied.
 */
export async function execute(tx: Sql, i: ExecuteInput): Promise<Executed> {
  const answer = answerToQuestion(i)
  const command = answer?.command ?? i.command
  const { today } = i
  switch (command.type) {
    case 'log':
      await insertMovements(tx, {
        accountId: i.accountId,
        inboundId: i.inboundId,
        movements: command.movements,
      })
      return say(renderReply(command, today, i.render))
    case 'help':
    case 'off_topic':
      return say(renderReply(command, today, i.render))
    case 'correct':
    case 'delete': {
      // Two positions in one message ("el 2 bórralo, cambiame el primero") are two actions.
      if (!answer && positionsIn(i.text, i.recent.length).length >= 2) return say(REPLY_ONE_THING)
      if (command.type === 'correct' && Object.values(command.changes).every((v) => v === null)) {
        return say(REPLY_NO_CHANGES)
      }
      // The pick was made on the list the model saw. If the ledger moved since, the numbers mean
      // other movements now: ask, listing the list as it is.
      const fresh = await recentMovements(tx, i.accountId)
      if (fresh.length !== i.recent.length || fresh.some((m, k) => m.id !== i.recent[k]?.id)) {
        const numbered: Numbered[] = fresh.map((movement, k) => ({ number: k + 1, movement }))
        return question(numbered.slice(0, 3), today)
      }
      const target = answer
        ? { kind: 'found' as const, movement: answer.movement }
        : resolveTarget(command, i.recent, { text: i.text, today })
      if (target.kind === 'ask') return question(target.candidates, today)
      const old = await lockLive(tx, i.accountId, target.movement.id)
      if (!old) return say(REPLY_GONE)
      const done = answer ? { command } : {}
      if (command.type === 'delete') {
        await softDelete(tx, old.id, i.inboundId)
        return { reply: renderDeletion(old, today), ...done }
      }
      const next = applyChanges(old, command.changes)
      const changed = changedFields(old, next)
      if (changed.length === 0) return { reply: renderUnchanged(old, today), ...done }
      await supersede(tx, { accountId: i.accountId, inboundId: i.inboundId, old, next })
      return { reply: renderCorrection(old, next, changed, today), ...done }
    }
    case 'query': {
      const totals = await queryTotals(tx, i.accountId, {
        direction: command.direction,
        category: command.category,
        payment: command.payment,
        range: periodRange(command.period, today),
      })
      return say(renderQuery(command, totals))
    }
  }
}
