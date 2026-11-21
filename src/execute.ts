import type { Action } from './agent'
import type { AuditEntry } from './agent/loop'
import { composeReply, type Say, type Step } from './agent/say'
import type { Sql } from './db'
import {
  insertMovements,
  liveByIds,
  lockLive,
  newestLiveId,
  queryTotals,
  softDelete,
  supersede,
} from './ledger'
import { applyChanges, changedFields } from './movement'
import {
  REPLY_GONE,
  REPLY_SAY_FALLBACK,
  type RenderOptions,
  renderAsk,
  renderCorrection,
  renderDeletion,
  renderHelp,
  renderLog,
  renderQuery,
  renderUnchanged,
} from './render'
import type { Executed } from './store'
import { periodRange } from './time'

export interface ExecuteInput {
  accountId: number
  /** The inbound message that carries the actions; what they create or end is linked to it. */
  inboundId: number
  /** What the model asked for (or the pending action a short answer chose), already validated. */
  actions: Action[]
  /** The loop's audit; each action's outcome is written into its entry. */
  audit: AuditEntry[]
  /** The Argentine day of the message. */
  today: string
  /**
   * What the model's own words may take numbers from, besides the lines this run renders: the person's
   * message, the context and the search results of this message (`contextFacts`).
   */
  /** The person's message, to drop a text that only echoes it. */
  message: string
  facts: string[]
  /** What Warren answered earlier in the conversation: the one proof a `reply` may lean on. */
  window: string[]
  render?: RenderOptions
  /** What was heard in a voice note: the reply starts with it, rendered by code. */
  heard?: string
}

/** The label `inbound_message.action` and the latency report use: one tool, or `multi`. */
export function actionLabel(actions: Action[]): string {
  const [only] = actions
  if (!only || actions.length > 1) return 'multi'
  const label = {
    log_movements: 'log',
    correct_movement: 'correct',
    delete_movement: 'delete',
    summarize: 'summarize',
    ask_user: 'ask',
    reply: 'reply',
    help: 'reply',
    notice: 'reply',
  } as const
  return label[only.tool]
}

/**
 * Runs a message's actions against the ledger, in order, and returns the one reply to store. It runs
 * inside the commit transaction, after the commit guard has passed, so a replay or a crash cannot
 * apply them twice. A correction or delete locks its movement and checks it is the sender's and
 * still live first: a message that ran in between may already have changed it, and then that action
 * says so and applies nothing; the other actions of the message still run. Every reply line comes
 * from a template over stored values.
 */
export async function execute(tx: Sql, i: ExecuteInput): Promise<Executed> {
  const { today } = i
  const newest = await newestLiveId(tx, i.accountId)
  /** Corrections insert rows too, so positions run across the whole message. */
  let position = 0
  const lines: string[] = []
  const steps: Step[] = []
  const out: Pick<Executed, 'asked' | 'pending'> = {}
  /** The model's words, to send after the lines if every number in them is one code gave. */
  const says: Say[] = []

  for (const [index, action] of i.actions.entries()) {
    // A `reply` is all text: an empty one is still refused (and answered), never skipped.
    // (`ask_user` has no text: code asks, once.)
    if (
      action.tool !== 'notice' &&
      'text' in action.input &&
      (action.input.text?.trim() || action.tool === 'reply')
    ) {
      says.push({ action: index, text: action.input.text ?? '' })
    }
    switch (action.tool) {
      case 'log_movements': {
        const { movements } = action.input
        await insertMovements(tx, {
          accountId: i.accountId,
          inboundId: i.inboundId,
          movements,
          firstPosition: position,
        })
        position += movements.length
        lines.push(renderLog(movements, today))
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
      }
      case 'correct_movement': {
        const old = await lockLive(tx, i.accountId, action.input.id)
        if (!old) {
          lines.push(REPLY_GONE)
          steps.push({ tool: action.tool, outcome: 'gone' })
          break
        }
        const next = applyChanges(old, action.input.changes)
        const changed = changedFields(old, next)
        if (changed.length === 0) {
          lines.push(renderUnchanged(old, today))
          steps.push({ tool: action.tool, outcome: 'unchanged' })
          break
        }
        await supersede(tx, {
          accountId: i.accountId,
          inboundId: i.inboundId,
          old,
          next,
          position: position++,
        })
        lines.push(renderCorrection(old, next, changed, today, old.id === newest))
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
      }
      case 'delete_movement': {
        const old = await lockLive(tx, i.accountId, action.input.id)
        if (!old) {
          lines.push(REPLY_GONE)
          steps.push({ tool: action.tool, outcome: 'gone' })
          break
        }
        await softDelete(tx, old.id, i.inboundId)
        lines.push(renderDeletion(old, today, old.id === newest))
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
      }
      case 'summarize': {
        const { period, direction, category, payment, description } = action.input
        const totals = await queryTotals(tx, i.accountId, {
          direction,
          category,
          payment,
          description,
          range: periodRange(period, today),
        })
        lines.push(renderQuery({ period, direction, category, payment, description }, totals))
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
      }
      case 'ask_user': {
        const a = action.input
        // Only the sender's live movements are offered, newest first, however the model ordered them.
        const options =
          a.movement_ids.length > 0 ? await liveByIds(tx, i.accountId, a.movement_ids) : []
        lines.push(renderAsk(a.question, options, a.after_answer, today))
        steps.push({ tool: action.tool, outcome: 'applied' })
        if (!out.asked && options.length > 0) {
          out.asked = options.map((m, k) => ({ number: k + 1, id: m.id }))
          if (a.after_answer === 'delete') out.pending = { action: 'delete' }
          if (a.after_answer === 'correct' && a.changes) {
            out.pending = { action: 'correct', changes: a.changes }
          }
        }
        break
      }
      case 'help':
        lines.push(renderHelp(i.render))
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
      case 'notice':
        lines.push(action.input.text)
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
      case 'reply':
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
    }
  }

  // The model's words go after the record, never instead of it, and only with numbers code gave.
  const { reply, verdicts } = composeReply({
    lines,
    says,
    steps,
    message: i.message,
    facts: i.facts,
    window: i.window,
    fallback: REPLY_SAY_FALLBACK,
    heard: i.heard,
  })
  const audit = i.audit.map((e) =>
    e.action === undefined
      ? e
      : { ...e, status: steps[e.action]?.outcome ?? e.status, ...verdicts.get(e.action) },
  )
  return { reply, ...out, audit }
}
