import type { Action } from './agent'
import type { AuditEntry } from './agent/loop'
import { composeReply, type Say, type Step } from './agent/say'
import type { Sql } from './db'
import {
  insertMovements,
  liveByIds,
  lockLive,
  newestLiveId,
  softDelete,
  summaryRows,
  supersede,
} from './ledger'
import { applyChanges, changedFields } from './movement'
import { previousRange, type Resolved, resolveRange } from './range'
import {
  REPLY_GONE,
  REPLY_SAY_FALLBACK,
  REPLY_UNDO_EXPIRED,
  REPLY_UNDO_NOTHING,
  type RenderOptions,
  renderAsk,
  renderCorrection,
  renderDeletion,
  renderHelp,
  renderLog,
  renderStale,
  renderUnchanged,
  renderUndo,
  type UndoLine,
} from './render'
import { renderSummary, type Side } from './render-summary'
import type { Executed } from './store'
import { type Undone, undoLast } from './undo'

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
  /** What was heard in a voice note: a reply with no record of a change starts with it, rendered by code. */
  heard?: string
}

/** The tools whose line is the record of a change. */
const CHANGES = new Set(['log_movements', 'correct_movement', 'delete_movement', 'undo_last'])

/** The label `inbound_message.action` and the latency report use: one tool, or `multi`. */
export function actionLabel(actions: Action[]): string {
  const [only] = actions
  if (!only || actions.length > 1) return 'multi'
  const label = {
    log_movements: 'log',
    correct_movement: 'correct',
    delete_movement: 'delete',
    undo_last: 'undo',
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
  /** What the commit point did for an action, to keep in its audit entry. */
  const details = new Map<number, string>()

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
      case 'undo_last': {
        const undone = await undoLast(tx, { accountId: i.accountId, inboundId: i.inboundId })
        if (undone.kind === 'undone') {
          lines.push(renderUndo(undone.items.map(undoLine), today))
          steps.push({ tool: action.tool, outcome: 'applied' })
          details.set(
            index,
            `undid batch ${undone.batch}: ${undone.items.map((u) => `${u.kind} ${'movement' in u ? u.movement.id : u.from.id}`).join(', ')}`,
          )
          break
        }
        lines.push(
          undone.kind === 'nothing'
            ? REPLY_UNDO_NOTHING
            : undone.kind === 'expired'
              ? REPLY_UNDO_EXPIRED
              : renderStale(undone.moved, today),
        )
        steps.push({ tool: action.tool, outcome: undone.kind })
        if (undone.kind === 'stale') {
          details.set(index, `stale: ${undone.moved.map((m) => m.id).join(', ')}`)
        }
        break
      }
      case 'summarize': {
        const { range, group_by, compare_to, other, direction, category, payment, description } =
          action.input
        // `checkCall` already resolved these against the same day: a failure here is a bug, not a refusal.
        const resolved = (spec: typeof range): Resolved => {
          const r = resolveRange(spec, today)
          if (!r.ok) throw new Error(`summarize: ${r.reason}`)
          return r.range
        }
        const asked = resolved(range)
        const before =
          compare_to === 'previous'
            ? previousRange(asked)
            : compare_to === 'range' && other
              ? resolved(other)
              : null
        const side = async (r: Resolved): Promise<Side> => ({
          range: r,
          ...(await summaryRows(
            tx,
            i.accountId,
            { direction, category, payment, description, range: r },
            group_by,
          )),
        })
        const now = await side(asked)
        lines.push(
          renderSummary(
            { direction, category, payment, description, groupBy: group_by },
            today,
            now,
            before ? await side(before) : null,
          ),
        )
        steps.push({ tool: action.tool, outcome: 'applied' })
        details.set(
          index,
          `${asked.from}..${asked.to}${before ? ` vs ${before.from}..${before.to}` : ''}${group_by === 'none' ? '' : ` by ${group_by}`}`,
        )
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
    // The record of a change already shows what was understood, amounts included: say what was heard only for
    // answers, summaries, questions and the model's own words, where nothing else shows it.
    heard: steps.some((s) => s.outcome === 'applied' && CHANGES.has(s.tool)) ? undefined : i.heard,
  })
  const audit = i.audit.map((e) =>
    e.action === undefined
      ? e
      : {
          ...e,
          status: steps[e.action]?.outcome ?? e.status,
          ...(details.has(e.action) ? { detail: details.get(e.action) } : {}),
          ...verdicts.get(e.action),
        },
  )
  return { reply, ...out, audit }
}

/** An undone movement as the record shows it: what it is after the undo, and what a restored correction was before. */
function undoLine(u: Undone): UndoLine {
  if (u.kind === 'corrected') {
    return { kind: u.kind, movement: u.to, from: u.from, changed: changedFields(u.from, u.to) }
  }
  return { kind: u.kind, movement: u.movement }
}
