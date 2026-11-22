import type { Action } from './agent'
import type { AuditEntry } from './agent/loop'
import { MAX_FACTS } from './agent/memory'
import { composeReply, type Say, type Step } from './agent/say'
import { applyCall, applyReminderCall } from './apply'
import { disconnectAccount } from './auth/disconnect'
import { askLink, confirmLink, declineLink } from './auth/link'
import type { Sql } from './core/db'
import { allLiveFacts, forgetAll } from './facts'
import { liveByIds, newestLiveId } from './ledger'
import { scrubAudit } from './redact'
import { liveReminders } from './reminders/db'
import { MAX_REMINDERS } from './reminders/guard'
import {
  REPLY_DISCONNECT,
  REPLY_FACT_GONE,
  REPLY_FACT_SECRET,
  REPLY_GONE,
  REPLY_LINK,
  REPLY_SAY_FALLBACK,
  REPLY_UNDO_EXPIRED,
  REPLY_UNDO_NOTHING,
  type RenderOptions,
  reminderReply,
  renderAsk,
  renderCorrection,
  renderDeletion,
  renderFacts,
  renderFactsFull,
  renderForgetAllAsk,
  renderForgot,
  renderForgotAll,
  renderForgotNone,
  renderHelp,
  renderKnown,
  renderLog,
  renderRemembered,
  renderReminders,
  renderStale,
  renderUnchanged,
  renderUndo,
  undoLine,
} from './render'
import { runSummary } from './run-summary'
import type { Executed } from './store'
import { undoDetail } from './undo'

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
  /** The instant of the message (its own time): a reminder's first occurrence, and what an undo brings back, are counted from it. */
  now: Date
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
  /** The message held something Warren must not keep: no word of the model's and no transcript in the reply, and an audit with no input (`redact.ts`). */
  redact?: boolean
}

/** The tools whose line is the record of a change. */
const CHANGES = new Set([
  'log_movements',
  'correct_movement',
  'delete_movement',
  'undo_last',
  'remember_fact',
  'forget_fact',
  'forget_all_confirmed',
  'set_reminder',
  'cancel_reminder',
])

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
      !i.redact &&
      action.tool !== 'notice' &&
      'text' in action.input &&
      (action.input.text?.trim() || action.tool === 'reply')
    ) {
      says.push({ action: index, text: action.input.text ?? '' })
    }
    switch (action.tool) {
      case 'log_movements':
      case 'correct_movement':
      case 'delete_movement':
      case 'undo_last':
      case 'remember_fact':
      case 'forget_fact': {
        // The writes are `applyCall`'s, the one path under both channels; this composes the reply from what it did.
        const done = await applyCall(
          tx,
          { accountId: i.accountId, batchId: i.inboundId, position, now: i.now },
          action,
        )
        position += done.rows
        switch (done.tool) {
          case 'log_movements':
            lines.push(renderLog(done.movements, today))
            steps.push({ tool: done.tool, outcome: 'applied' })
            break
          case 'correct_movement':
            if (done.kind === 'gone') {
              lines.push(REPLY_GONE)
            } else if (done.kind === 'unchanged') {
              lines.push(renderUnchanged(done.old, today))
            } else {
              lines.push(
                renderCorrection(done.old, done.next, done.changed, today, done.old.id === newest),
              )
            }
            steps.push({ tool: done.tool, outcome: done.kind })
            break
          case 'delete_movement':
            lines.push(
              done.kind === 'gone'
                ? REPLY_GONE
                : renderDeletion(done.old, today, done.old.id === newest),
            )
            steps.push({ tool: done.tool, outcome: done.kind })
            break
          case 'undo_last': {
            const undone = done.undo
            if (undone.kind === 'undone') {
              lines.push(renderUndo(undone.items.map(undoLine), today))
            } else {
              lines.push(
                undone.kind === 'nothing' || undone.kind === 'whatsapp_only'
                  ? REPLY_UNDO_NOTHING
                  : undone.kind === 'expired'
                    ? REPLY_UNDO_EXPIRED
                    : renderStale(undone.moved, today, undone.facts, undone.reminders),
              )
            }
            steps.push({
              tool: done.tool,
              outcome: undone.kind === 'undone' ? 'applied' : undone.kind,
            })
            const detail = undoDetail(undone)
            if (detail) details.set(index, detail)
            break
          }
          case 'remember_fact': {
            const stored = done.stored
            if (stored.kind === 'full') lines.push(renderFactsFull(MAX_FACTS))
            else if (stored.kind === 'unchanged') lines.push(renderKnown(stored.fact))
            else {
              lines.push(
                renderRemembered(
                  stored.fact,
                  stored.kind === 'updated' ? stored.before : undefined,
                ),
              )
            }
            steps.push({
              tool: done.tool,
              outcome:
                stored.kind === 'full'
                  ? 'full'
                  : stored.kind === 'unchanged'
                    ? 'unchanged'
                    : 'applied',
            })
            details.set(index, `${stored.kind}: ${done.kind} ${done.key}`)
            break
          }
          case 'forget_fact': {
            for (const fact of done.gone) lines.push(renderForgot(fact))
            if (done.gone.length === 0) {
              lines.push(done.id > 0 ? REPLY_FACT_GONE : renderForgotNone(done.key))
            }
            steps.push({ tool: done.tool, outcome: done.gone.length > 0 ? 'applied' : 'gone' })
            break
          }
        }
        break
      }
      case 'forget_all_facts': {
        // Code asks, and only the person's "sí" (`forget_all_confirmed`) forgets: nothing is forgotten here.
        const known = await allLiveFacts(tx, i.accountId)
        if (known.length === 0) {
          lines.push(renderFacts([]))
          steps.push({ tool: action.tool, outcome: 'nothing' })
          break
        }
        lines.push(renderForgetAllAsk(known.length))
        steps.push({ tool: action.tool, outcome: 'asked' })
        // Its own kind of question: nothing is offered to pick, so no options are stored. Only this action asks (it goes alone).
        out.pending = { action: 'forget_all' }
        break
      }
      case 'forget_all_confirmed': {
        const gone = await forgetAll(tx, i.accountId, i.inboundId)
        lines.push(gone.length > 0 ? renderForgotAll(gone.length) : renderFacts([]))
        steps.push({ tool: action.tool, outcome: gone.length > 0 ? 'applied' : 'nothing' })
        break
      }
      case 'link_ask': {
        // Connecting an agent (docs/mcp-spec.md, Design 3). Code asks; the question is the one this message's reply
        // carries, so only the very next "sí" or "no" can answer it.
        const asked = await askLink(tx, action.input.code, i.accountId)
        if (!asked) {
          lines.push(REPLY_LINK.refused)
          steps.push({ tool: action.tool, outcome: 'refused' })
          break
        }
        lines.push(REPLY_LINK.ask(asked.client))
        steps.push({ tool: action.tool, outcome: 'asked' })
        out.pending = { action: 'link', link_id: asked.id }
        break
      }
      case 'link_confirm': {
        const client = await confirmLink(tx, action.input.link_id, i.accountId)
        lines.push(client ? REPLY_LINK.done(client) : REPLY_LINK.refused)
        steps.push({ tool: action.tool, outcome: client ? 'applied' : 'gone' })
        break
      }
      case 'link_decline': {
        const closed = await declineLink(tx, action.input.link_id, i.accountId)
        lines.push(REPLY_LINK.declined)
        steps.push({ tool: action.tool, outcome: closed ? 'applied' : 'gone' })
        break
      }
      case 'mcp_disconnect': {
        const cut = await disconnectAccount(tx, i.accountId)
        lines.push(cut === 0 ? REPLY_DISCONNECT.none : REPLY_DISCONNECT.done(cut))
        steps.push({ tool: action.tool, outcome: cut === 0 ? 'nothing' : 'applied' })
        break
      }
      case 'set_reminder':
      case 'cancel_reminder': {
        const done = await applyReminderCall(
          tx,
          { accountId: i.accountId, batchId: i.inboundId, now: i.now },
          action,
        )
        const { line, outcome } = reminderReply(done, today, MAX_REMINDERS)
        lines.push(line)
        steps.push({ tool: done.tool, outcome })
        if (done.tool === 'set_reminder' && done.kind === 'applied') {
          details.set(index, `reminder ${done.reminder.id}`)
        }
        break
      }
      case 'list_reminders':
        lines.push(renderReminders(await liveReminders(tx, i.accountId), today))
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
      case 'list_facts':
        lines.push(renderFacts(await allLiveFacts(tx, i.accountId)))
        steps.push({ tool: action.tool, outcome: 'applied' })
        break
      case 'summarize': {
        const {
          current,
          previous,
          lines: summary,
        } = await runSummary(tx, i.accountId, action.input, today)
        lines.push(...summary)
        steps.push({ tool: action.tool, outcome: 'applied' })
        const { group_by } = action.input
        details.set(
          index,
          `${current.range.from}..${current.range.to}${previous ? ` vs ${previous.range.from}..${previous.range.to}` : ''}${group_by === 'none' ? '' : ` by ${group_by}`}`,
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
        // The model's own words could repeat what was said: answer a message that holds a secret with code's line.
        if (i.redact) lines.push(REPLY_FACT_SECRET)
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
    heard:
      i.redact || steps.some((s) => s.outcome === 'applied' && CHANGES.has(s.tool))
        ? undefined
        : i.heard,
  })
  const audit = (i.redact ? scrubAudit(i.audit) : i.audit).map((e) =>
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
